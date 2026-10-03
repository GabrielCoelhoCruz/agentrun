"""Real PTY CLI demo. Explicit fake-provider entry; never calls paid providers."""
import errno, fcntl, json, os, pathlib, pty, select, signal, struct, subprocess, sys, termios, time

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
prompt = 'retry-success' if scenario == 'retry' else 'deadline-active' if scenario == 'timeout' else 'panel-demo hold' if scenario == 'interrupted' else 'panel-demo'
(repo / 'TASKS.md').write_text(('---\nconcurrency: 3\nstallTimeout: 2 seconds\nmaxDuration: 10 seconds\n---\n' if scenario == 'retry' else '---\nconcurrency: 3\nstallTimeout: 2 seconds\nmaxDuration: 5 seconds\n---\n' if scenario == 'timeout' else '---\nconcurrency: 3\n---\n') + '\n'.join(
    f'## task{n}: Task {n} 界 👩‍💻 long title for narrow terminals\n{prompt}' + (' fail' if scenario == 'failed' and n == 1 else '') + '\n'
    for n in range(3)))
env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ['TOKEN', 'SECRET', 'API_KEY', 'CREDENTIAL', 'AUTH'])}
env.update(HOME=str(home), TEST_RECORDS=str(root), TERM='xterm-256color', NO_COLOR='1')
args = [node, str(entry), 'run', 'TASKS.md', '--load-project-settings']
if scenario == 'resume':
    first = subprocess.run(args + ['--json'], cwd=repo, env=env, capture_output=True, timeout=20)
    assert first.returncode == 0, first.stderr
    saved_path = next((repo / '.agentrun/runs').glob('*/state.json'))
    saved = json.loads(saved_path.read_text())
    saved['status']['task1'] = {'_tag': 'failed', 'attempt': 1, 'reason': 'saved failure'}
    saved['status']['task2'] = {'_tag': 'pending'}
    # Match report checkpoints to this synthetic unfinished state.
    saved.get('taskReports', {}).pop('task1', None)
    saved.get('taskReports', {}).pop('task2', None)
    saved_path.write_text(json.dumps(saved))
    args = [node, str(entry), 'resume', '--retry-failed', '--load-project-settings']
if scenario == 'json': args += ['--json']
frames = []
start = time.monotonic()
raw = bytearray()
if scenario in ['pipe', 'json']:
    # JSON must remain clean even with a real TTY stdout. Keep stderr separate.
    if scenario == 'json':
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        p = subprocess.Popen(args, cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE)
        os.close(slave)
        while True:
            try:
                part = os.read(master, 65536)
                if not part: break
                raw.extend(part)
            except OSError as error:
                if error.errno != errno.EIO: raise
                break
        _, stderr = p.communicate(timeout=20)
        os.close(master)
    else:
        p = subprocess.Popen(args, cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = p.communicate(timeout=20)
        raw.extend(stdout)
    (root / 'stderr.txt').write_bytes(stderr)
else:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    p = subprocess.Popen(args, cwd=repo, env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
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
            if not running and b'task2 [running]' in raw and (b'Tool result: checked file' in raw or b'Runner retry 2' in raw):
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
        if p.poll() is None:
            p.send_signal(signal.SIGINT)
            p.wait(timeout=8)
        os.close(master)
(root / 'capture.ansi').write_bytes(raw)
(root / 'result.json').write_text(json.dumps({'scenario': scenario, 'command': args, 'cwd': str(repo), 'env': {'HOME': str(home), 'TEST_RECORDS': str(root), 'TERM': env['TERM'], 'NO_COLOR': '1'}, 'pid': p.pid, 'exitCode': p.returncode, 'dimensions': [80, 24], 'frames': frames, 'savedStatus': json.loads(next((repo / '.agentrun/runs').glob('*/state.json')).read_text())['status'], 'elapsedSeconds': time.monotonic() - start}, indent=2))
print(str(root / 'result.json'))
