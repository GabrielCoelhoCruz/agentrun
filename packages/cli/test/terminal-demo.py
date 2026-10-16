import errno, fcntl, json, os, pathlib, select, signal, struct, subprocess, sys, termios, time
sys.dont_write_bytecode = True
from terminal_fixture import RUN_SECONDS, STALL_SECONDS, Fixture

scenario, target, node = sys.argv[1:]
retry_duration_seconds = 30
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
(repo / 'TASKS.md').write_text((f'---\nconcurrency: 3\nstallTimeout: 20 seconds\nmaxDuration: {retry_duration_seconds} seconds\n---\n' if scenario == 'retry' else '---\nconcurrency: 3\nstallTimeout: 30 seconds\nmaxDuration: 10 seconds\n---\n' if scenario == 'timeout' else '---\nconcurrency: 3\n---\n') + '\n'.join(
    f'## task{n}: Task {n} 界 👩‍💻 long title for narrow terminals\n{prompt}' + (' fail' if scenario == 'failed' and n == 1 else '') + '\n'
    for n in range(3)))
env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ['TOKEN', 'SECRET', 'API_KEY', 'CREDENTIAL', 'AUTH'])}
env.update(HOME=str(home), TEST_RECORDS=str(root), TERM='xterm-256color', NO_COLOR='1')

def pump(p, sources, on_output=lambda: None):
    # Reads each descriptor until it closes, then waits for exit. A slow host still makes progress;
    # only silence for STALL_SECONDS or a run longer than RUN_SECONDS fails.
    started = progressed = time.monotonic()
    def remaining():
        now = time.monotonic()
        if now - started > RUN_SECONDS: raise TimeoutError(f'{scenario} run exceeded {RUN_SECONDS} seconds')
        if now - progressed > STALL_SECONDS: raise TimeoutError(f'{scenario} run made no progress for {STALL_SECONDS} seconds')
        return min(started + RUN_SECONDS, progressed + STALL_SECONDS) - now
    while sources:
        ready, _, _ = select.select(list(sources), [], [], remaining())
        for descriptor in ready:
            try:
                part = os.read(descriptor, 65536)
            except OSError as error:
                if error.errno != errno.EIO: raise
                part = b''
            if part:
                sources[descriptor].extend(part)
                progressed = time.monotonic()
            else:
                del sources[descriptor]
        on_output()
    progressed = time.monotonic()
    try:
        p.wait(timeout=remaining())
    except subprocess.TimeoutExpired:
        raise TimeoutError(f'{scenario} run closed its output but did not exit within {STALL_SECONDS} seconds')

with Fixture(root) as fixture:
    args = [node, str(entry), 'run', 'TASKS.md', '--load-project-settings']
    if scenario == 'resume':
        first = fixture.spawn(args + ['--json'], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        first_stderr = bytearray()
        pump(first, {first.stdout.fileno(): bytearray(), first.stderr.fileno(): first_stderr})
        assert first.returncode == 0, first_stderr
        saved_path = next((repo / '.agentrun/runs').glob('*/state.json'))
        saved = json.loads(saved_path.read_text())
        saved['status']['task1'] = {'_tag': 'failed', 'attempt': 1, 'reason': 'saved failure'}
        saved['status']['task2'] = {'_tag': 'pending'}
        saved.get('taskReports', {}).pop('task1', None)
        saved.get('taskReports', {}).pop('task2', None)
        saved_path.write_text(json.dumps(saved))
        args = [node, str(entry), 'resume', '--retry-failed', '--load-project-settings']
    if scenario == 'json': args += ['--json']
    frames = []
    start = time.monotonic()
    raw = bytearray()
    stderr = bytearray()
    try:
        if scenario == 'pipe':
            p = fixture.spawn(args, cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            pump(p, {p.stdout.fileno(): raw, p.stderr.fileno(): stderr})
        elif scenario == 'json':
            master, slave = fixture.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
            p = fixture.spawn(args, cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE)
            fixture.closefd(slave)
            pump(p, {master: raw, p.stderr.fileno(): stderr})
        else:
            master, slave = fixture.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
            p = fixture.spawn(args, cwd=repo, env=env, stdin=slave, stdout=slave, stderr=slave)
            fixture.closefd(slave)
            running = resized = interrupted = False
            def react():
                global running, resized, interrupted
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
            pump(p, {master: raw}, react)
    finally:
        (root / 'capture.ansi').write_bytes(raw)
        if scenario in ['pipe', 'json']: (root / 'stderr.txt').write_bytes(stderr)
    (root / 'result.json').write_text(json.dumps({'scenario': scenario, 'command': args, 'cwd': str(repo), 'env': {'HOME': str(home), 'TEST_RECORDS': str(root), 'TERM': env['TERM'], 'NO_COLOR': '1'}, 'pid': p.pid, 'exitCode': p.returncode, 'dimensions': [80, 24], 'frames': frames, 'savedStatus': json.loads(next((repo / '.agentrun/runs').glob('*/state.json')).read_text())['status'], 'elapsedSeconds': time.monotonic() - start}, indent=2))
    print(str(root / 'result.json'))
