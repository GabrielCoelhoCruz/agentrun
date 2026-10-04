import errno, fcntl, json, os, pathlib, select, signal, struct, subprocess, sys, termios, time
sys.dont_write_bytecode = True
from terminal_fixture import Fixture

scenario, target, node = sys.argv[1:]
root = pathlib.Path(target).resolve()
root.mkdir(parents=True, exist_ok=True)
repo, home = root / 'repo', root / 'home'
repo.mkdir(); home.mkdir()
entry = pathlib.Path(__file__).resolve().parent / 'fixtures/dist/entry.mjs'
def git(*args):
    subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True)
git('init', '-q')
(repo / '.gitignore').write_text('.agentrun/\n')
(repo / 'seed').write_text('base\n')
git('add', '.')
git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base')
prompt = 'panel-demo hold' if scenario == 'interrupted' else 'panel-demo'
(repo / 'TASKS.md').write_text('---\nconcurrency: 3\n---\n' + '\n'.join(
    f'## task{n}: Task {n} 界 👩‍💻 long title for narrow terminals\n{prompt}' + (' fail' if scenario == 'failed' and n == 1 else '') + '\n'
    for n in range(3)))
env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ['TOKEN', 'SECRET', 'API_KEY', 'CREDENTIAL', 'AUTH'])}
env.update(HOME=str(home), TEST_RECORDS=str(root), TERM='xterm-256color', NO_COLOR='1')
with Fixture(root) as fixture:
    args = [node, str(entry), 'run', 'TASKS.md', '--load-project-settings']
    if scenario == 'resume':
        first = fixture.spawn(args + ['--json'], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _, first_stderr = first.communicate(timeout=20)
        assert first.returncode == 0, first_stderr
        saved_path = next((repo / '.agentrun/runs').glob('*/state.json'))
        saved = json.loads(saved_path.read_text())
        saved['status']['task1'] = {'_tag': 'failed', 'attempt': 1, 'reason': 'saved failure'}
        saved['status']['task2'] = {'_tag': 'pending'}
        saved_path.write_text(json.dumps(saved))
        args = [node, str(entry), 'resume', '--retry-failed', '--load-project-settings']
    if scenario == 'json': args += ['--json']
    frames = []
    start = time.monotonic()
    raw = bytearray()
    if scenario in ['pipe', 'json']:
        if scenario == 'json':
            master, slave = fixture.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
            p = fixture.spawn(args, cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE)
            fixture.closefd(slave)
            while True:
                remaining = 20 - (time.monotonic() - start)
                if remaining <= 0: raise subprocess.TimeoutExpired(args, 20)
                ready, _, _ = select.select([master], [], [], min(.05, remaining))
                if not ready: continue
                try:
                    part = os.read(master, 65536)
                    if not part: break
                    raw.extend(part)
                except OSError as error:
                    if error.errno != errno.EIO: raise
                    break
            _, stderr = p.communicate(timeout=20)
            fixture.closefd(master)
        else:
            p = fixture.spawn(args, cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, stderr = p.communicate(timeout=20)
            raw.extend(stdout)
        (root / 'stderr.txt').write_bytes(stderr)
    else:
        master, slave = fixture.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        p = fixture.spawn(args, cwd=repo, env=env, stdin=slave, stdout=slave, stderr=slave)
        fixture.closefd(slave)
        resized = interrupted = running = False
        try:
            while True:
                if time.monotonic() - start > 22: raise TimeoutError('PTY demo exceeded 22 seconds')
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    try:
                        part = os.read(master, 65536)
                        if not part: break
                        raw.extend(part)
                    except OSError as error:
                        if error.errno != errno.EIO: raise
                        break
                elapsed = time.monotonic() - start
                if not running and b'task2 [running]' in raw and b'Tool result: checked file' in raw:
                    (root / 'running.ansi').write_bytes(raw)
                    frames.append({'name': 'running', 'columns': 80, 'rows': 24, 'bytes': len(raw)})
                    running = True
                if scenario == 'resize' and running and not resized:
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 32, 0, 0))
                    p.send_signal(signal.SIGWINCH)
                    frames.append({'name': 'resize', 'columns': 32, 'rows': 12, 'bytes': len(raw)})
                    resized = True
                if scenario == 'interrupted' and running and not interrupted:
                    p.send_signal(signal.SIGINT)
                    interrupted = True
            p.wait(timeout=5)
        finally:
            (root / 'capture.ansi').write_bytes(raw)
            fixture.closefd(master)
    (root / 'capture.ansi').write_bytes(raw)
    (root / 'result.json').write_text(json.dumps({'scenario': scenario, 'command': args, 'cwd': str(repo), 'env': {'HOME': str(home), 'TEST_RECORDS': str(root), 'TERM': env['TERM'], 'NO_COLOR': '1'}, 'pid': p.pid, 'exitCode': p.returncode, 'dimensions': [80, 24], 'frames': frames, 'savedStatus': json.loads(next((repo / '.agentrun/runs').glob('*/state.json')).read_text())['status'], 'elapsedSeconds': time.monotonic() - start}, indent=2))
    print(str(root / 'result.json'))
