"""Linux Docker proof. Run each boundary intact, weakened (red), and intact again.

Failures: host PATH writes, checkout writes (EROFS/EACCES), host-pid visibility,
Actions file writes, surviving children, invalid public schema, and broken journeys.
Only fake keys are used. Weakening flags exist only in this proof, not the CLI.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys

factory = Path(__file__).resolve().parents[3]
root = Path(sys.argv[1]).resolve()
root.mkdir()
(root / 'target.json').write_text(json.dumps({
    'command': ['/usr/bin/python3', '-I', *sys.argv],
    'revision': subprocess.check_output(['/usr/bin/git', 'rev-parse', 'HEAD'], cwd=factory, text=True).strip(),
    'head': os.environ.get('AGENTRUN_PULL_REQUEST_HEAD'),
    'image': 'agentrun-journey:local', 'cwd': str(factory),
}, indent=2) + '\n')
spec = importlib.util.spec_from_file_location('journey_container', Path(__file__).with_name('journey_container.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
key = 'fake-review-key-0123456789-abcdefgh'
# Preserve the runner's original PATH before the step fixes its own PATH.
# Ask sudo for the actual secure_path without executing a searched command.
secure_path = subprocess.check_output(['/usr/bin/sudo', '-n', '/usr/bin/printenv', 'PATH'],
                                      env={'PATH': module.PATH}, text=True).strip()
host_dirs = sorted(set(os.environ.get('FACTORY_PROOF_HOST_PATH', os.environ['PATH']).split(':')
                       + secure_path.split(':') + ['/opt/pipx_bin', '/usr/local/.ghcup/bin']))
results = []


def tree_hash(directory):
    digest = hashlib.sha256()
    for parent, dirs, files in os.walk(directory):
        dirs[:] = sorted(name for name in dirs if name not in ['node_modules', '.git', '__pycache__'])
        for name in sorted(files):
            path = Path(parent) / name
            digest.update(str(path.relative_to(directory)).encode())
            digest.update(path.read_bytes() if not path.is_symlink() else os.readlink(path).encode())
    return digest.hexdigest()


def snapshot():
    return {str(Path(directory) / name): (Path(directory) / name).exists()
            for directory in host_dirs for name in ['pkill', 'sudo', 'pgrep', 'tar', 'git']}


def check(case, result, before, container, alive):
    if case == 'host-path':
        return (all(value in ['EROFS', 'EACCES', 'EPERM', 'ENOENT', 'EEXIST'] for value in result.values())
                and snapshot() == before
                and all(subprocess.check_output(['/usr/bin/which', name], env={'PATH': module.PATH}, text=True).strip()
                        == '/usr/bin/' + name for name in ['pkill', 'pgrep', 'tar', 'git', 'sudo']))
    if case == 'checkout':
        return (result['write'] in ['EROFS', 'EACCES']
                and tree_hash(factory) == before['checkout'] and tree_hash(container.build) == before['build'])
    if case == 'host-pid':
        return result.get('visible') is False and result.get('error') == 'ENOENT'
    if case == 'channels':
        return (result['inherited'] == [] and all(result[name] in ['ENOENT', 'EROFS', 'EACCES']
                and (container.channels / name).read_text() == 'original=value\n'
                for name in ['GITHUB_ENV', 'GITHUB_STEP_SUMMARY']))
    if case == 'background':
        return alive and not container.exists()
    return result == {'positive': True}


# The exact same launcher, image, mounts and environment are used by the journey.
for case in ['host-path', 'checkout', 'host-pid', 'channels', 'background']:
    for phase in ['green-before', 'red', 'green-after']:
        directory = root / (case + '-' + phase)
        directory.mkdir()
        work = directory / 'work'
        work.mkdir()
        env = {'ANTHROPIC_API_KEY': key, 'FACTORY_JOURNEY_FIXTURE': '1',
               'FACTORY_FIXTURE_JOURNEY_ATTACK': case, 'FACTORY_FIXTURE_HOST_PID': str(os.getpid()),
               'FACTORY_FIXTURE_HOST_DIRS': json.dumps(host_dirs)}
        container = module.Container(factory, directory / 'control', work, env,
                                     weaken=case if phase == 'red' else None)
        before = {'checkout': tree_hash(factory), 'build': tree_hash(container.build)} if case == 'checkout' else snapshot()
        try:
            container.start()
            run = container.run(['/usr/local/bin/node', '--input-type=module', '-e',
                                 "import {probe} from 'file:///opt/proof/container-probe.mjs'; probe()"], '/work')
            assert run.returncode == 0, run.stderr.decode()
            result = json.loads((work / 'probe.json').read_text())
            alive = case == 'background' and container.run(['/bin/kill', '-0', str(result['pid'])], '/work').returncode == 0
            if case != 'background' or phase != 'red':
                container.stop()
            passed = check(case, result, before, container, alive)
            row = {'container': container.name, 'containerId': container.identifier, 'case': case, 'phase': phase, 'observed': result, 'boundary_passed': passed,
                   'expected': phase != 'red', 'passed': passed == (phase != 'red')}
            if case == 'checkout':
                row['hashes'] = {'before': before, 'after': {'checkout': tree_hash(factory), 'build': tree_hash(container.build)}}
            results.append(row)
            (root / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
            print(json.dumps(row), flush=True)
            assert row['passed'], row
        finally:
            container.stop()
            shutil.rmtree(container.control)

# Positive control: fixture provider runs the real start/decide/export journey.
case = root / 'journey'
case.mkdir()
hook = case / 'hook.mjs'
source = (factory / 'packages/factory/test/fixtures/provider-hooks.mjs').read_text()
marker = "  record({ kind: 'provider', stage: task.stage,"
source = source.replace("import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport {probe} from 'file:///opt/proof/container-probe.mjs';")
hook.write_text(source.replace(marker, '  probe();\n' + marker))
for example, extension in [('notes-ts', 'ts'), ('notes-py', 'py')]:
    env = dict(os.environ, ANTHROPIC_API_KEY=key, FACTORY_JOURNEY_FIXTURE='1',
               FACTORY_FIXTURE_HOOK=str(hook), FACTORY_FIXTURE_MODE='happy',
               FACTORY_FIXTURE_JOURNEY_ATTACK='happy', FACTORY_FIXTURE_SOURCE='server.' + extension,
               FACTORY_FIXTURE_DURABLE='/opt/proof/server-durable.' + extension,
               FACTORY_FIXTURE_ECHO_SECRET='1')
    command = ['/usr/bin/python3', '-I', str(factory / 'packages/factory/scripts/separated-journey.py'),
               '--factory', str(factory), '--out', str(case / example), '--id', 'container-' + example,
               '--example', 'examples/factory/' + example]
    run = subprocess.run(command, env=env, capture_output=True, timeout=300)
    (case / (example + '.log')).write_bytes(run.stdout + run.stderr)
    assert run.returncode == 0 and run.stdout == b'RESULT PASS\n', run.stdout + run.stderr
    assert key.encode() not in run.stdout + run.stderr
    public = case / example
    assert (public / 'report.txt').read_text() == 'RESULT PASS\n'
    assert 'patch=derived\nindependent-check=0\nnegative-control=1\n' in (public / 'exits.txt').read_text()
    scanner = ['/usr/bin/python3', '-I', str(factory / 'packages/factory/scripts/journey-evidence.py'), 'scan', str(public)]
    assert subprocess.run(scanner, env=env, capture_output=True).returncode == 0
    original = (public / 'start.json').read_bytes()
    (public / 'start.json').write_text('{"agentText":"unexpected"}')
    assert subprocess.run(scanner, env=env, capture_output=True).returncode == 1
    (public / 'start.json').write_bytes(original)
    assert subprocess.run(scanner, env=env, capture_output=True).returncode == 0
    results.append({'case': example, 'phase': 'positive-and-schema-red-green', 'passed': True})
    (root / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print('PASS ' + example + ': journey, schema red/green, rebuilt patch, independent/negative checks', flush=True)
