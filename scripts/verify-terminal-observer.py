import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

out = Path(sys.argv[1]).resolve()
kind = sys.argv[2]
wt = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else Path(__file__).resolve().parents[1]
out.mkdir(exist_ok=False)
real_ps = shutil.which('ps')
nonce = uuid.uuid4().hex
root = out / f'guard-{nonce}'
bin_dir = out / 'bin'
bin_dir.mkdir()
(bin_dir / 'sitecustomize.py').write_text("import os, signal, sys\nif sys.argv[0].endswith('/terminal-demo.py'): os.kill(os.getpid(), signal.SIGSTOP)\n")
shim = bin_dir / 'ps'
shim.write_text(f'''#!{sys.executable}
import os, pathlib, sys, time
out = pathlib.Path({str(out)!r})
end = time.monotonic() + 3
while not (out / 'guard.pid').exists() and time.monotonic() < end: time.sleep(.01)
if (out / 'guard.pid').exists() and os.getppid() == int((out / 'guard.pid').read_text()):
    counter = out / 'ps-count'
    count = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(count))
    if count in {([1] if kind == 'sentinel' else [2, 3])!r}:
        if count == {1 if kind == 'sentinel' else 2}:
            (out / 'awaiting').touch()
            while not (out / 'release').exists() and time.monotonic() < end: time.sleep(.01)
        sys.stderr.write('injected observer inspection failure\\n')
        sys.exit(17)
os.execv({real_ps!r}, [{real_ps!r}, *sys.argv[1:]])
''')
shim.chmod(0o755)
env = {**os.environ, 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'], 'PYTHONPATH': str(bin_dir)}
args = [sys.executable, str(wt / 'scripts/verify-terminal-cleanup.py'), str(root), 'pipe']
records = []
p = None


def save(name, value):
    (out / name).write_text(json.dumps(value, indent=2) + '\n')


def table():
    rows = []
    result = subprocess.run([real_ps, '-ww', '-axo', 'pid=,ppid=,uid=,lstart=,stat=,command='],
                            capture_output=True, text=True, check=True, timeout=8)
    for line in result.stdout.splitlines():
        v = line.split(None, 9)
        rows.append(dict(pid=int(v[0]), parent=int(v[1]), uid=int(v[2]), start=' '.join(v[3:8]), state=v[8], command=v[9]))
    return rows


def current(record):
    row = next((r for r in table() if r['pid'] == record['pid'] and not r['state'].startswith('Z')), None)
    if row is not None and any(row[k] != record[k] for k in ['pid', 'uid', 'start', 'command']):
        raise RuntimeError('Probe rescue refused a changed identity')
    return row


try:
    save('command.json', dict(args=args, cwd=str(wt), kind=kind, nonce=nonce,
                             head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=wt, text=True).strip(),
                             node=subprocess.check_output(['node', '--version'], text=True).strip(),
                             guardSha256=hashlib.sha256((wt / 'scripts/verify-terminal-cleanup.py').read_bytes()).hexdigest(),
                             probeSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()))
    with (out / 'guard.log').open('w') as log:
        p = subprocess.Popen(args, cwd=wt, env=env, stdout=log, stderr=subprocess.STDOUT)
        (out / 'guard.pid').write_text(str(p.pid))
        end = time.monotonic() + 15
        while not (out / 'awaiting').exists():
            if p.poll() is not None or time.monotonic() >= end:
                raise RuntimeError('Observer fault was not reached')
            time.sleep(.01)
        records = [r for r in table() if r['parent'] == p.pid and
                   ('pr9-f1-foreign-' in r['command'] or '/terminal-demo.py ' in r['command'])]
        assert len(records) == (1 if kind == 'sentinel' else 2), records
        save('owned-before.json', records)
        (out / 'release').touch()
        code = p.wait(timeout=20)
    remaining = [r for record in records if (r := current(record)) is not None]
    save('result.json', dict(guardExit=code, remainingBeforeRescue=remaining, observerRescueBeforeObservation=False))
    assert code != 0 and 'injected observer inspection failure' in (out / 'guard.log').read_text()
    assert not remaining, f'Guard leaked its owned processes: {remaining}'
    print(f'PASS {kind}: failed inspection left no guard-owned process')
finally:
    signals = []
    try:
        for record in records:
            if current(record) is not None:
                assert record['uid'] == os.getuid()
                assert 'pr9-f1-foreign-' in record['command'] or nonce in record['command']
                os.kill(record['pid'], signal.SIGKILL)
                signals.append(record['pid'])
    finally:
        if p is not None:
            if p.poll() is None:
                p.kill()
            p.wait(timeout=5)
    time.sleep(.2)
    remaining = [r for record in records if (r := current(record)) is not None]
    save('rescue.json', dict(signaled=signals, remaining=remaining))
    assert not remaining, 'Probe rescue left a process alive'
