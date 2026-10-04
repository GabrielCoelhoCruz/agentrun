import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid


def write(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def table(timeout=5):
    result = subprocess.run(
        ['ps', '-ww', '-axo', 'pid=,ppid=,uid=,lstart=,stat=,command='],
        capture_output=True, text=True, check=True, timeout=timeout,
    )
    rows = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 9)
        if len(fields) != 10:
            raise RuntimeError('Process inspection returned an invalid row')
        rows[int(fields[0])] = dict(pid=int(fields[0]), parent=int(fields[1]), uid=int(fields[2]),
                                   start=' '.join(fields[3:8]), state=fields[8], command=fields[9])
    return rows


def alive(row):
    return row is not None and not row['state'].startswith('Z')


def matches(record, row):
    return (row['uid'] == os.getuid() == record['uid'] and row['start'] == record['start']
            and row['pid'] == record['pid'] and row['command'] in record['commands'])


def close(root, nonce):
    owner = root / 'terminal-owner.json'
    if not owner.exists():
        return
    if json.loads(owner.read_text()) != nonce:
        raise RuntimeError('Fixture ownership changed; cleanup refused')
    deadline = time.monotonic() + 48
    phase_deadline = deadline - 24
    records = {}
    refused = []
    signals = []

    def inspect():
        remaining = phase_deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Fixture cleanup phase exceeded its deadline')
        return table(min(5, remaining))

    def owned(record, rows):
        row = rows.get(record['pid'])
        if not alive(row) or not matches(record, row):
            return False
        authority = record.get('authority')
        if authority is None:
            return nonce in row['command']
        if 'workerToken' in authority:
            return f"agentrun-worker-{authority['workerToken']}" in row['command'].split()
        parent = authority['parent']
        return row['parent'] == parent['pid'] and owned(parent, rows)

    def current(record):
        rows = inspect()
        row = rows.get(record['pid'])
        if not alive(row):
            return None
        if not owned(record, rows):
            raise RuntimeError(f"Process {record['pid']} identity changed; cleanup refused")
        return row

    def send(record, sig):
        if current(record) is not None:
            try:
                os.kill(record['pid'], sig)
                signals.append(dict(pid=record['pid'], signal=signal.Signals(sig).name))
            except ProcessLookupError:
                pass

    def remember(row, authority):
        record = dict(row, commands=[row['command']], authority=authority, nonce=nonce)
        old = records.get(row['pid'])
        if old is not None and not matches(old, row):
            raise RuntimeError('Observed process reuse; cleanup refused')
        records[row['pid']] = record
        write(root / 'terminal-owned.json', list(records.values()))
        return record

    def attempt(action):
        try:
            action()
        except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, subprocess.SubprocessError) as error:
            refused.append(f'Cleanup refused: {error}')

    def discover():
        saved = root / 'terminal-owned.json'
        if saved.exists():
            def load_saved():
                for record in json.loads(saved.read_text()):
                    def load_record():
                        if record['nonce'] != nonce:
                            raise RuntimeError('Process receipt nonce changed; cleanup refused')
                        if current(record) is not None:
                            records[record['pid']] = record
                    attempt(load_record)
            attempt(load_saved)
        for path in root.glob('terminal-child-*.json'):
            def load_child():
                record = json.loads(path.read_text())
                if record['nonce'] != nonce or not all(nonce in command for command in record['commands']):
                    raise RuntimeError('Launcher receipt nonce changed; cleanup refused')
                row = current(record)
                if row is not None:
                    records[row['pid']] = record
                    write(root / 'terminal-owned.json', list(records.values()))
                    send(record, signal.SIGSTOP)
            attempt(load_child)
        def load_worker(worker):
            pid = worker.get('pgid')
            if pid is None:
                return
            row = inspect().get(pid)
            if not alive(row):
                return
            token = worker.get('processToken', '')
            if not re.fullmatch('[a-f0-9]{32}', token) or f'agentrun-worker-{token}' not in row['command'].split():
                raise RuntimeError(f'Worker {pid} token changed; cleanup refused')
            remember(row, dict(workerToken=token))

        for path in (root / 'repo/.agentrun/runs').glob('*/state.json'):
            def load_workers():
                for worker in json.loads(path.read_text())['worktrees'].values():
                    attempt(lambda: load_worker(worker))
            attempt(load_workers)
        frozen = set()
        while True:
            for pid, record in list(records.items()):
                if pid not in frozen:
                    attempt(lambda: send(record, signal.SIGSTOP))
                    frozen.add(pid)
            rows = inspect()
            if any(owned(record, rows) and 'T' not in rows[pid]['state'] for pid, record in records.items()):
                time.sleep(.01)
                continue
            additions = []
            for row in rows.values():
                parent = records.get(row['parent'])
                if row['pid'] in records or not alive(row) or parent is None:
                    continue
                parent_row = rows.get(parent['pid'])
                if alive(parent_row) and owned(parent, rows) and 'T' in parent_row['state']:
                    additions.append((row, parent))
            if not additions:
                break
            for row, parent in additions:
                attempt(lambda: remember(row, dict(parent=parent)))

    try:
        attempt(discover)
        phase_deadline = deadline
        for record in reversed(list(records.values())):
            attempt(lambda: send(record, signal.SIGKILL))
        while True:
            rows = inspect()
            remaining = [r for r in records.values() if alive(rows.get(r['pid'])) and matches(r, rows[r['pid']])]
            if not remaining or time.monotonic() >= deadline:
                break
            time.sleep(.05)
        if remaining:
            refused.append('Owned processes remain after SIGKILL')
    finally:
        write(root / 'terminal-cleanup.json', dict(signals=signals, refused=refused, records=list(records.values())))
    if refused:
        raise RuntimeError('; '.join(refused))


class Fixture:
    def __init__(self, root):
        self.root = root
        self.nonce = os.environ.get('AGENTRUN_TERMINAL_NONCE', uuid.uuid4().hex)
        self.children = []
        self.descriptors = set()
        write(root / 'terminal-owner.json', self.nonce)

    def __enter__(self):
        self.previous_signal = signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
        return self

    def __exit__(self, *_):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        previous_interrupt = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            close(self.root, self.nonce)
        finally:
            for child in self.children:
                if child.returncode is None:
                    child.kill()
                child.wait(timeout=5)
            for descriptor in self.descriptors:
                os.close(descriptor)
            signal.signal(signal.SIGTERM, self.previous_signal)
            signal.signal(signal.SIGINT, previous_interrupt)

    def openpty(self):
        master, slave = os.openpty()
        self.descriptors.update([master, slave])
        return master, slave

    def closefd(self, descriptor):
        os.close(descriptor)
        self.descriptors.remove(descriptor)

    def spawn(self, args, **kwargs):
        gate, release = os.pipe()
        child = None
        try:
            child = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), 'launch', str(self.root), self.nonce,
                 str(gate), json.dumps(args)], pass_fds=(gate,), **kwargs,
            )
            self.children.append(child)
            path = self.root / f'terminal-child-{child.pid}.json'
            deadline = time.monotonic() + 5
            while not path.exists():
                if child.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Fixture launcher did not register within 5 seconds')
                time.sleep(.01)
            os.write(release, b'1')
            return child
        finally:
            os.close(gate)
            os.close(release)


def launch(root, nonce, gate, args):
    command = [args[0], f'--conditions=agentrun-terminal-{nonce}', *args[1:]]
    row = table()[os.getpid()]
    write(root / f'terminal-child-{os.getpid()}.json',
          dict(row, nonce=nonce, commands=[row['command'], ' '.join(command)]))
    if os.read(gate, 1) != b'1':
        return
    os.close(gate)
    os.execvpe(command[0], command, os.environ)


if __name__ == '__main__':
    action, target, nonce, *rest = sys.argv[1:]
    if action == 'launch':
        launch(Path(target), nonce, int(rest[0]), json.loads(rest[1]))
    elif action == 'close':
        close(Path(target), nonce)
    else:
        raise ValueError('Unknown fixture action')
