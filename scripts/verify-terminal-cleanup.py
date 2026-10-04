import json
import os
from pathlib import Path
import hashlib
import shutil
import signal
import subprocess
import sys
import time
import uuid

wt = Path(__file__).resolve().parents[1]
node = shutil.which('node')
assert node, 'Node is required'
mode = sys.argv[2] if len(sys.argv) > 2 else 'pipe'
added_outer = mode in ['retry-outer', 'timeout-outer']
outer = mode == 'outer' or added_outer
scenario = {'retry-outer': 'retry', 'timeout-outer': 'timeout', 'pty': 'success', 'exception': 'success', 'normal': 'success', 'ownership': 'pipe', 'outer': 'json', 'hold': 'pipe', 'resume-second': 'resume', 'missing-state': 'pipe', 'bad-receipt': 'pipe', 'bad-worker': 'pipe', 'freeze-stall': 'pipe', 'freeze-hold': 'pipe'}.get(mode, mode)
out = Path(sys.argv[1]).resolve()
out.mkdir(exist_ok=False)
root = out / 'fixture'
root.mkdir()
identities = {}
receipts = []
refused = []
p = foreign = None
foreign_identity = None
workers = []
cli = None
result = {}

def save(name, value):
    (out / name).write_text(json.dumps(value, indent=2) + '\n')

def table():
    r = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,uid=,lstart=,stat=,command='], capture_output=True, text=True, timeout=8)
    if r.returncode != 0:
        raise RuntimeError('Process inspection failed: ' + r.stderr)
    rows = []
    for line in r.stdout.splitlines():
        v = line.strip().split(None, 10)
        if len(v) != 11:
            raise RuntimeError('Invalid process row: ' + line)
        rows.append(dict(pid=int(v[0]), parent=int(v[1]), group=int(v[2]), uid=int(v[3]), start=' '.join(v[4:9]), state=v[9], command=v[10]))
    return rows

def same(a, b):
    return all(a[k] == b[k] for k in ['pid', 'uid', 'group', 'start', 'command'])

def live(row):
    return not row['state'].startswith('Z')

def remember(rows, parent):
    owned = {parent}
    while True:
        additions = {r['pid'] for r in rows if r['parent'] in owned}
        if additions <= owned:
            break
        owned |= additions
    for row in rows:
        if row['pid'] in owned:
            old = identities.get(row['pid'])
            if old and (old['uid'] != row['uid'] or old['start'] != row['start']):
                raise RuntimeError('Observed PID reuse')
            identities[row['pid']] = row

def current(record):
    row = next((r for r in table() if r['pid'] == record['pid'] and live(r)), None)
    if row is None:
        return None
    if not same(row, record):
        refused.append({'expected': record, 'observed': row})
        raise RuntimeError('Cleanup refused changed identity')
    return row

def send(record, sig, leader=False, token=None):
    row = current(record)
    if row is None:
        return
    if leader and (row['group'] != row['pid'] or not token or token not in row['command'].split()):
        refused.append({'record': row, 'reason': 'Unverified group ownership'})
        raise RuntimeError('Cleanup refused unknown group')
    try:
        os.kill(row['pid'], sig)
        receipts.append({'identity': row, 'signal': signal.Signals(sig).name, 'leader': leader, 'token': token})
    except ProcessLookupError:
        receipts.append({'identity': row, 'alreadyExited': True})

try:
    env = {k:v for k,v in os.environ.items() if not any(s in k.upper() for s in ['TOKEN','SECRET','API_KEY','CREDENTIAL','AUTH'])}
    marker = 'pr9-f1-foreign-' + uuid.uuid4().hex
    foreign = subprocess.Popen([node, '-e', 'setInterval(() => {}, 1000)', marker], env=env, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    save('foreign-handle.json', {'pid': foreign.pid, 'args': foreign.args, 'marker': marker})
    foreign_identity = next(r for r in table() if r['pid'] == foreign.pid)
    save('foreign-owned-by-observer.json', foreign_identity)
    args = [sys.executable, str(wt / 'packages/cli/test/terminal-demo.py'), scenario, str(root), node]
    command = {'args':args, 'cwd':str(wt), 'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=wt,text=True).strip(), 'originalDeadlineSeconds':30 if outer else 22 if mode in ['pty', 'resume-second', 'normal', 'exception'] else 20, 'fault':mode, 'sourceSha256':hashlib.sha256((wt/'packages/cli/test/terminal-demo.py').read_bytes()).hexdigest(), 'sourceHashes': {f: hashlib.sha256((wt / f).read_bytes()).hexdigest() for f in ['packages/cli/test/terminal-demo.py', 'packages/cli/test/terminal_fixture.py', 'packages/cli/test/Terminal.test.ts', 'scripts/verify-terminal-cleanup.py', 'scripts/terminal-cleanup-deadline.cjs', 'scripts/verify-terminal-observer.py'] if (wt / f).exists()}, 'dirty': subprocess.check_output(['git', 'status', '--porcelain'], cwd=wt, text=True)}
    if outer:
        env['NODE_OPTIONS'] = '--require=' + str(wt / 'scripts/terminal-cleanup-deadline.cjs')
        env['AGENTRUN_TEST_EVIDENCE'] = str(root)
        args = [node, str(wt / 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'cli', 'packages/cli/test/Terminal.test.ts', '--maxWorkers=1', '-t', 'real PTY: ' + scenario]
    if mode in ['freeze-stall', 'freeze-hold']:
        driver = out / 'freeze-driver.py'
        driver.write_text("import sys\nfrom pathlib import Path\np = Path(sys.argv[1])\nsys.path.insert(0, str(p.parent))\nsys.dont_write_bytecode = True\nimport terminal_fixture\noriginal = terminal_fixture.table\ndef stalled(timeout=5):\n    rows = original(timeout)\n    for row in rows.values():\n        if 'fake-worker.mjs agentrun-worker-' in row['command'] and row['state'].startswith('T'):\n            row['state'] = 'S'\n    return rows\nterminal_fixture.table = stalled\nsys.argv = sys.argv[1:]\nsource = p.read_text()\nif 'freeze-hold' == 'MODE_PLACEHOLDER': source = source.replace(\"else 'panel-demo'\", \"else 'panel-demo hold'\")\nexec(compile(source, str(p), 'exec'), {'__file__': str(p), '__name__': '__main__'})\n".replace('MODE_PLACEHOLDER', mode))
        args.insert(1, str(driver))
    if mode == 'hold':
        driver = out / 'hold-driver.py'
        driver.write_text("import sys\nfrom pathlib import Path\np = Path(sys.argv[1])\nsys.path.insert(0, str(p.parent))\nsys.argv = sys.argv[1:]\nsource = p.read_text().replace(\"else 'panel-demo'\", \"else 'panel-demo hold'\")\nexec(compile(source, str(p), 'exec'), {'__file__': str(p), '__name__': '__main__'})\n")
        args.insert(1, str(driver))
    save('command.json', {**command, 'args': args})
    start = time.monotonic()
    with (out/'driver.stdout').open('wb') as stdout, (out/'driver.stderr').open('wb') as stderr:
        p = subprocess.Popen(args,cwd=wt,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
        save('driver-handle.json', {'pid': p.pid, 'args': p.args})
        readiness = time.monotonic() + (90 if outer else 18)
        while time.monotonic()<readiness:
            rows=table()
            remember(rows,p.pid)
            needle = '/fixtures/dist/entry.mjs resume --retry-failed' if mode == 'resume-second' else '/fixtures/dist/entry.mjs run TASKS.md --load-project-settings'
            candidates=[r for r in rows if r['pid'] in identities and needle in r['command']]
            if outer:
                roots = list(root.glob('terminal-' + scenario + '-*'))
                fixture = roots[0] if roots else root
            else:
                fixture = root
            states=list((fixture/'repo/.agentrun/runs').glob('*/state.json'))
            if candidates and states and (added_outer or all((fixture/f'starts-task{n}').exists() for n in range(3))):
                saved=json.loads(states[0].read_text())
                workers=[{'pgid':x['pgid'],'token':'agentrun-worker-'+x['processToken']} for x in saved['worktrees'].values() if 'pgid' in x and 'processToken' in x]
                if mode == 'resume-second':
                    workers = [w for w in workers if any(r['pid'] == w['pgid'] and live(r) for r in rows)]
                if added_outer:
                    workers = [w for w in workers if any(r['pid'] == w['pgid'] and live(r) and w['token'] in r['command'].split() for r in rows)]
                if (added_outer and not workers) or (not added_outer and len(workers) != (2 if mode == 'resume-second' else 3)):
                    time.sleep(.05)
                    continue
                if mode in ['hold', 'freeze-hold'] and not all((fixture / f'child-task{n}').exists() for n in range(3)):
                    time.sleep(.05)
                    continue
                cli=candidates[0]
                for w in workers:
                    leader=next((r for r in rows if r['pid']==w['pgid'] and r['group']==w['pgid'] and w['token'] in r['command'].split() and live(r)),None)
                    if leader is None:
                        raise RuntimeError('Worker ownership is not proven before fault')
                    identities[leader['pid']]=leader
                    if added_outer:
                        send(leader, signal.SIGSTOP, leader=True, token=w['token'])
                if added_outer:
                    assert any(current(identities[w['pgid']]) is not None and current(identities[w['pgid']])['state'].startswith('T') for w in workers), 'Worker fault was not reached'
                save('state-before-fault.json',saved)
                save('processes-before-fault.json',list(identities.values()))
                if mode != 'normal':
                    send(cli,signal.SIGSTOP)
                    save('fault-receipt.json',receipts[-1])
                if outer:
                    driver = next(r for r in rows if r['pid'] == cli['parent'])
                    send(driver, signal.SIGSTOP)
                    save('stopped-python.json', driver)
                    if added_outer:
                        assert scenario in (fixture / 'repo/TASKS.md').read_text() or scenario == 'timeout' and 'deadline-active' in (fixture / 'repo/TASKS.md').read_text()
                        assert current(driver)['state'].startswith('T'), 'Python fault was not reached'
                        save('fault-precondition.json', {'scenario': scenario, 'workers': workers, 'cli': cli, 'python': driver, 'saved': saved})
                        fault_at = time.monotonic()
                if mode == 'exception':
                    send(identities[p.pid], signal.SIGTERM)
                if mode == 'bad-worker':
                    saved['worktrees'] = {'malformed': None, **saved['worktrees']}
                    states[0].write_text(json.dumps(saved))
                if mode == 'bad-receipt':
                    nonce = json.loads((root / 'terminal-owner.json').read_text())
                    (root / 'terminal-owned.json').write_text(json.dumps([{'nonce': nonce}]))
                if mode == 'missing-state':
                    states[0].write_text('{}')
                if mode == 'ownership':
                    saved['worktrees']['foreign'] = {'pgid': foreign.pid, 'processToken': '0' * 32}
                    states[0].write_text(json.dumps(saved))
                    original = next(root.glob('terminal-child-*.json'))
                    record = json.loads(original.read_text())
                    record['pid'] = foreign.pid
                    record['start'] = 'not the current start time'
                    (root / 'terminal-child-forged.json').write_text(json.dumps(record))
                break
            if p.poll() is not None:
                raise RuntimeError('Driver completed before fault readiness')
            time.sleep(.05)
        else:
            raise TimeoutError('Fault readiness not reached; original driver remains unmodified')
        try:
            if added_outer:
                end = time.monotonic() + 85
                released = False
                while p.poll() is None and time.monotonic() < end:
                    if not released and time.monotonic() - fault_at > 32:
                        if current(driver) is not None:
                            send(driver, signal.SIGKILL)
                            save('forced-python-death.json', receipts[-1])
                        released = True
                    time.sleep(.1)
                code = p.wait(timeout=1)
            else:
                code=p.wait(timeout=85)
        except subprocess.TimeoutExpired:
            raise TimeoutError('Observer deadline reached; not a successful driver-deadline reproduction')
    rows=table()
    remaining=[r for r in rows if live(r) and (r['pid'] in identities or any(r['group']==w['pgid'] for w in workers))]
    err=(out/'driver.stderr').read_text()
    result={'driverExit':code,'elapsedSeconds':time.monotonic()-start,'expectedFailure': 'normal exit' if mode == 'normal' else 'outer 30-second timeout' if outer else 'PTY 22-second timeout' if mode in ['pty', 'resume-second'] else 'injected exception' if mode == 'exception' else '20-second timeout','deadlineObserved':'subprocess.TimeoutExpired' in err and '20 seconds' in err,'liveBeforeRescue':remaining,'cli':cli,'workers':workers,'foreignStillAlive':current(foreign_identity) is not None,'rescuePerformedBeforeObservation':False, 'mode':mode}
    if outer:
        deadline = json.loads((root / 'outer-deadline.json').read_text())
        result['outerDeadline'] = deadline
        result['deadlineObserved'] = deadline['timeout'] == 30000 and deadline['error'] == 'ETIMEDOUT'
    save('result.json',result)
    if mode in ['pipe', 'resume', 'json', 'hold', 'missing-state', 'bad-receipt', 'bad-worker', 'freeze-stall', 'freeze-hold']:
        assert code == 1 and result['deadlineObserved'], 'Original deadline did not produce the expected failure'
    elif mode in ['pty', 'resume-second']:
        assert code == 1 and 'PTY demo exceeded 22 seconds' in err, err
    elif outer:
        deadline = json.loads((root / 'outer-deadline.json').read_text())
        assert code != 0 and deadline['timeout'] == 30000 and deadline['error'] == 'ETIMEDOUT' and deadline['signal'] in (['SIGKILL', 'SIGTERM'] if added_outer else ['SIGKILL']), deadline
    elif mode == 'normal':
        assert code == 0, err
        assert not json.loads((root / 'terminal-cleanup.json').read_text())['signals'], 'Normal exit required fixture rescue'
    elif mode == 'ownership':
        assert code != 0 and 'refused' in err.lower(), err
    else:
        assert code != 0, 'Injected failure did not fail the driver'
    assert not remaining, f'Owned resources survived driver cleanup: {remaining}'
    assert result['foreignStillAlive'], 'Foreign sentinel unexpectedly stopped'
    print(f'PASS {mode}: zero owned resources before rescue; foreign preserved', flush=True)
finally:
    errors=[]
    def reap(child):
        try:
            if child.poll() is None:
                child.kill()
                receipts.append({'unreapedHandle': child.pid, 'signal': 'SIGKILL'})
            child.wait(timeout=5)
        except Exception as error:
            errors.append(repr(error))
    if p is not None:
        try:
            rows=table()
            remember(rows,p.pid)
            if cli:
                send(cli,signal.SIGKILL)
            for w in workers:
                leader=identities.get(w['pgid'])
                if leader:
                    send(leader,signal.SIGKILL,leader=True,token=w['token'])
            for record in list(identities.values()):
                if record['pid']==p.pid:
                    continue
                send(record,signal.SIGKILL)
            if p.poll() is None:
                record=identities.get(p.pid)
                if record:
                    send(record,signal.SIGKILL)
            p.wait(timeout=5)
        except Exception as error:
            errors.append(repr(error))
        finally:
            reap(p)
    if foreign is not None:
        try:
            alive_before = foreign.poll() is None if foreign_identity is None else current(foreign_identity) is not None
            save('foreign-preserved-through-rescue.json',{'alive':alive_before,'identity':foreign_identity})
            if not alive_before:
                raise RuntimeError('Foreign sentinel was not preserved through rescue')
            if foreign_identity is not None:
                send(foreign_identity,signal.SIGKILL)
        except Exception as error:
            errors.append(repr(error))
        finally:
            reap(foreign)
    time.sleep(.5)
    rows = []
    remaining = None
    try:
        rows = table()
        remaining = [r for r in rows if live(r) and (r['pid'] in identities or any(r['group'] == w['pgid'] for w in workers) or (foreign is not None and r['pid'] == foreign.pid))]
    except Exception as error:
        errors.append(repr(error))
    save('cleanup.json', {'signals': receipts, 'refused': refused, 'errors': errors, 'remaining': remaining, 'processInspectionSucceeded': remaining is not None, 'identities': list(identities.values()), 'foreignPid': foreign.pid if foreign else None})
    save('processes-after.json', [r for r in rows if r['pid'] in identities or (foreign is not None and r['pid'] == foreign.pid)])
    if errors or remaining is None or remaining:
        raise RuntimeError('Cleanup incomplete; inspect cleanup.json')
