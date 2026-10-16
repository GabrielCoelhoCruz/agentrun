"""The only launcher for agent code. No host tool or source mounts are writable."""
import os
from pathlib import Path
import shutil
import re
import subprocess
import uuid

PATH = '/usr/sbin:/usr/bin:/sbin:/bin'
IMAGE = 'agentrun-journey:local'


class Container:
    def __init__(self, factory, control, work, supplied, weaken=None):
        # Mutation switches are callable by the no-secret proof only. The journey
        # CLI never accepts them. A paid key cannot enable a weakened boundary.
        if weaken and supplied.get('ANTHROPIC_API_KEY') != 'fake-review-key-0123456789-abcdefgh':
            raise ValueError('Mutation requires the proof key')
        self.name = 'agentrun-journey-' + uuid.uuid4().hex
        self.owner = os.environ.get('GITHUB_RUN_ID', 'local') + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', self.owner):
            raise ValueError('Invalid container owner')
        self.control = Path(control)
        self.control.mkdir()
        self.build = self.control / 'build'
        self.build.mkdir()
        for relative in ['node_modules', 'package.json'] + [f'packages/{package}/{name}'
                for package in ['core', 'cli', 'factory'] for name in ['dist', 'node_modules', 'package.json']]:
            source = Path(factory) / relative
            dest = self.build / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, dest, symlinks=True)
            else:
                shutil.copyfile(source, dest)
        self.work = Path(work)
        self.supplied = supplied
        self.weaken = weaken
        self.channels = self.control / 'channels'
        self.channels.mkdir()
        for name in ['GITHUB_ENV', 'GITHUB_STEP_SUMMARY']:
            (self.channels / name).write_text('original=value\n')
        self.env = {'PATH': PATH, 'HOME': str(self.control), 'LANG': 'C.UTF-8'}
        self.started = False

    def docker(self, *args, **kwargs):
        return subprocess.run(['/usr/bin/docker', *args], env=self.env, capture_output=True, **kwargs)

    def start(self, secret=True):
        env = {'PATH': '/opt/tools:/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/agent', 'TMPDIR': '/tmp',
               'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'GIT_CONFIG_NOSYSTEM': '1',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_ATTR_NOSYSTEM': '1',
               'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': '/dev/null',
               'GIT_CONFIG_KEY_1': 'core.fsmonitor', 'GIT_CONFIG_VALUE_1': 'false',
               'XDG_CONFIG_HOME': '/home/agent/.config', 'XDG_CACHE_HOME': '/home/agent/.cache',
               'CLAUDE_CONFIG_DIR': '/home/agent/.claude', 'PI_CODING_AGENT_DIR': '/home/agent/.pi'}
        if secret:
            env['ANTHROPIC_API_KEY'] = self.supplied['ANTHROPIC_API_KEY']
            if self.supplied.get('FACTORY_JOURNEY_FIXTURE') == '1':
                for key in ['FACTORY_FIXTURE_MODE', 'FACTORY_FIXTURE_SOURCE', 'FACTORY_FIXTURE_DURABLE',
                            'FACTORY_FIXTURE_JOURNEY_ATTACK', 'FACTORY_FIXTURE_HOST_PID',
                            'FACTORY_FIXTURE_HOST_DIRS', 'FACTORY_FIXTURE_ECHO_SECRET']:
                    if key in self.supplied:
                        env[key] = self.supplied[key]
                env['FACTORY_FIXTURE_LOG'] = '/work/providers.jsonl'
                if self.supplied.get('FACTORY_FIXTURE_HOOK'):
                    shutil.copyfile(self.supplied['FACTORY_FIXTURE_HOOK'], self.work / 'hook.mjs')
                    env['NODE_OPTIONS'] = '--import=file:///work/hook.mjs'
        uid, gid = os.getuid(), os.getgid()
        if uid == 0:
            raise ValueError('Run the harness as a non-root user')
        options = ['create', '--name', self.name, '--label', 'agentrun.journey-owner=' + self.owner, '--user', f'{uid}:{gid}', '--read-only',
                   '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
                   '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--tmpfs',
                   f'/home/agent:rw,nosuid,nodev,mode=0700,uid={uid},gid={gid}',
                   '--mount', f'type=bind,src={self.build},dst=/factory' + ('' if self.weaken == 'checkout' else ',readonly'),
                   '--mount', f'type=bind,src={self.work},dst=/work']
        if self.weaken == 'host-pid':
            options += ['--pid=host']
        if self.weaken == 'channels':
            options += ['--mount', f'type=bind,src={self.channels},dst=/host-channels']
        if self.weaken == 'host-path':
            decoy = self.control / 'host-path'
            decoy.mkdir()
            options += ['--mount', f'type=bind,src={decoy},dst=/opt/pipx_bin']
        for name in env:
            options += ['--env', name]
        result = subprocess.run(['/usr/bin/docker', *options, IMAGE], env={**self.env, **env}, capture_output=True)
        if result.returncode:
            raise RuntimeError('Cannot create agent container')
        self.started = True
        if self.docker('start', self.name).returncode:
            raise RuntimeError('Cannot start agent container')

    def run(self, command, cwd, extra=None):
        options = ['exec', '--workdir', cwd]
        for name, value in (extra or {}).items():
            options += ['--env', f'{name}={value}']
        return self.docker(*options, self.name, *command)

    def exists(self):
        result = self.docker('container', 'ls', '-aq', '--filter', 'name=^/' + self.name + '$')
        if result.returncode:
            raise RuntimeError('Cannot verify container removal')
        return bool(result.stdout.strip())

    def stop(self):
        if self.started:
            if self.docker('rm', '-f', self.name).returncode and self.exists():
                raise RuntimeError('Cannot remove agent container')
            if self.exists():
                raise RuntimeError('Agent container remains')
            self.started = False
