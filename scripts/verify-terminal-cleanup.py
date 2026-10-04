import json
import os
import re
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
added_outer = mode in ['retry-outer', 'timeout-outer', 'rescue-siblings']
outer = mode == 'outer' or added_outer
scenario = {'rescue-siblings': 'timeout', 'retry-outer': 'retry', 'timeout-outer': 'timeout', 'pty': 'success', 'exception': 'success', 'normal': 'success', 'ownership': 'pipe', 'outer': 'json', 'hold': 'pipe', 'resume-second': 'resume', 'missing-state': 'pipe', 'bad-receipt': 'pipe', 'bad-worker': 'pipe', 'freeze-stall': 'pipe', 'freeze-hold': 'pipe'}.get(mode, mode)
out = Path(sys.argv[1]).resolve()
out.mkdir(exist_ok=False)
root = out / 'fixture'
root.mkdir()
identities = {}
unverified = {}
transitions = []
receipts = []
refused = []
p = foreign = None
foreign_identity = None
workers = []
cli = None
result = {}
late_workers = []

class IdentityChanged(RuntimeError):
    pass

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

def complete(row):
    return row['uid'] == os.getuid() and bool(row['command']) and not row['command'].startswith(('(', '<'))

def launch_transition(old, row):
    if any(old[k] != row[k] for k in ['pid', 'uid', 'group', 'start']):
        return False
    for owner in root.rglob('terminal-owner.json'):
        receipt = owner.parent / f"terminal-child-{row['pid']}.json"
        try:
            if owner.is_symlink() or receipt.is_symlink():
                continue
            nonce = json.loads(owner.read_text())
            data = json.loads(receipt.read_text())
            if (not isinstance(nonce, str) or not re.fullmatch('[a-f0-9]{32}', nonce)
                    or data['nonce'] != nonce or data['parent'] != old['parent']
                    or any(data[k] != old[k] for k in ['pid', 'uid', 'start'])
                    or data['commands'] != [old['command'], row['command']]
                    or not all(nonce in command for command in data['commands'])):
                continue
            transitions.append({'original': old, 'identity': row, 'receiptPath': str(receipt), 'receipt': data})
            save('exec-transitions.json', transitions)
            return True
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            refused.append({'receiptPath': str(receipt), 'error': repr(error)})
    return False

def register(row):
    pid = row['pid']
    if not complete(row):
        if unverified.get(pid) != row:
            refused.append({'observed': row, 'reason': 'Incomplete process identity'})
        unverified.setdefault(pid, row)
        raise IdentityChanged('Registration refused incomplete identity')
    old = identities.get(pid)
    if old and not same(old, row) and not launch_transition(old, row):
        refused.append({'expected': old, 'observed': row})
        unverified.setdefault(pid, row)
        raise IdentityChanged('Registration refused changed identity')
    if old is None or not same(old, row):
        identities[pid] = dict(row)
    unverified.pop(pid, None)
    return identities[pid]

def descendants(rows, parent):
    scope = {parent}
    while True:
        additions = {r['pid'] for r in rows if r['parent'] in scope}
        if additions <= scope:
            break
        scope |= additions
    return scope

def remember(rows, parent):
    scope = descendants(rows, parent)
    pending = [parent]
    verified = set()
    by_pid = {r['pid']: r for r in rows}
    while pending:
        pid = pending.pop()
        row = by_pid.get(pid)
        if row is None or pid in verified:
            continue
        try:
            record = register(row)
        except IdentityChanged:
            continue
        if record:
            verified.add(pid)
            pending.extend(r['pid'] for r in rows if r['parent'] == pid)
    for row in rows:
        if row['pid'] in scope and row['pid'] not in verified:
            unverified.setdefault(row['pid'], row)
    return scope

def current(record):
    saved = identities.get(record['pid'])
    if saved is None or not same(saved, record):
        refused.append({'expected': saved, 'observed': record, 'reason': 'Unregistered signal identity'})
        raise IdentityChanged('Cleanup refused unregistered identity')
    record = saved
    if not complete(record):
        refused.append({'record': record, 'reason': 'Incomplete signal identity'})
        raise IdentityChanged('Cleanup refused incomplete identity')
    deadline = time.monotonic() + .5
    while True:
        row = next((r for r in table() if r['pid'] == record['pid'] and live(r)), None)
        if row is None:
            return None
        if same(row, record):
            unverified.pop(record['pid'], None)
            return row
        refused.append({'expected': record, 'observed': row})
        unverified.setdefault(record['pid'], row)
        if time.monotonic() >= deadline:
            raise IdentityChanged('Cleanup refused changed identity')
        time.sleep(.02)

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

def freeze_tree(record, receipt):
    captured = descendants(list(identities.values()) + list(unverified.values()), record['pid'])
    send(record, signal.SIGSTOP)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        row = current(record)
        if row is None:
            raise RuntimeError('CLI exited before complete fault inventory')
        if 'T' not in row['state']:
            time.sleep(.01)
            continue
        rows = table()
        captured |= remember(rows, record['pid'])
        unresolved = set()
        for pid in captured:
            if pid not in identities:
                unresolved.add(pid)
                continue
            try:
                send(identities[pid], signal.SIGSTOP)
            except IdentityChanged:
                unresolved.add(pid)
        rows = table()
        expanded = remember(rows, record['pid'])
        if expanded <= captured and all(not live(r) or (
                r['pid'] in identities and same(identities[r['pid']], r) and 'T' in r['state']
                and r['pid'] not in unresolved and r['pid'] not in unverified)
                for r in rows if r['pid'] in captured):
            save(receipt, {'cliStopped': True, 'identities': [identities[pid] for pid in captured if pid in identities], 'unverified': [unverified[pid] for pid in captured if pid in unverified], 'stoppedRows': [r for r in rows if r['pid'] in captured]})
            return
        captured |= expanded
    raise TimeoutError('Complete fault inventory did not freeze within 5 seconds')

def remaining_owned(rows):
    paths = [str(root), str(root.resolve())]
    entries = [str(wt / 'packages/cli/test/fixtures/dist' / name) for name in ['entry.mjs', 'fake-worker.mjs']]
    return [r for r in rows if live(r) and (r['pid'] in identities or r['pid'] in unverified or any(r['group'] == w['pgid'] for w in workers)
            or any(path in r['command'] for path in paths + entries)
            or any(r['pid'] == w['pid'] and w['token'] in r['command'].split() for w in late_workers))]

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
        readiness = time.monotonic() + (90 if outer else 20 + 22 if mode == 'resume-second' else 18)
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
                    assert saved['status']['task0']['_tag'] == 'succeeded', 'Task 0 did not remain succeeded before resume fault'
                    workers = [w for w in workers if any(r['pid'] == w['pgid'] and live(r) for r in rows)]
                if added_outer:
                    workers = [w for w in workers if any(r['pid'] == w['pgid'] and live(r) and w['token'] in r['command'].split() for r in rows)]
                if (added_outer and not workers) or (not added_outer and len(workers) != (2 if mode == 'resume-second' else 3)):
                    time.sleep(.05)
                    continue
                if mode in ['hold', 'freeze-hold'] and not all((fixture / f'child-task{n}').exists() for n in range(3)):
                    time.sleep(.05)
                    continue
                cli=register(candidates[0])
                for w in workers:
                    leader=next((r for r in rows if r['pid'] in identities and r['pid']==w['pgid'] and r['group']==w['pgid'] and w['token'] in r['command'].split() and live(r)),None)
                    if leader is None:
                        raise RuntimeError('Worker ownership is not proven before fault')
                    leader=register(leader)
                    if added_outer:
                        send(leader, signal.SIGSTOP, leader=True, token=w['token'])
                if added_outer:
                    assert any(current(identities[w['pgid']]) is not None and current(identities[w['pgid']])['state'].startswith('T') for w in workers), 'Worker fault was not reached'
                save('state-before-fault.json',saved)
                save('processes-before-fault.json',list(identities.values()))
                if mode == 'rescue-siblings':
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        fresh = table()
                        state = json.loads(states[0].read_text())
                        late_workers = [dict(pid=w['pgid'], token='agentrun-worker-'+w['processToken']) for w in state['worktrees'].values() if 'pgid' in w and 'processToken' in w]
                        if len(late_workers) == 3 and all(any(r['pid'] == w['pid'] and live(r) and w['token'] in r['command'].split() for r in fresh) for w in late_workers):
                            break
                        time.sleep(.01)
                    else:
                        raise RuntimeError('Sibling startup precondition was not reached')
                    save('late-workers.json', late_workers)
                if mode != 'normal':
                    send(cli,signal.SIGSTOP)
                    save('fault-receipt.json',receipts[-1])
                    freeze_tree(cli, 'complete-fault-inventory.json')
                if outer:
                    driver = identities[cli['parent']]
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
    remaining=remaining_owned(rows)
    err=(out/'driver.stderr').read_text()
    result={'driverExit':code,'elapsedSeconds':time.monotonic()-start,'expectedFailure': 'normal exit' if mode == 'normal' else 'outer 30-second timeout' if outer else 'PTY 22-second timeout' if mode in ['pty', 'resume-second'] else 'injected exception' if mode == 'exception' else '20-second timeout','deadlineObserved':'subprocess.TimeoutExpired' in err and '20 seconds' in err,'liveBeforeRescue':remaining,'unrecordedScopedBeforeRescue':[r for r in remaining if r['pid'] not in identities],'cli':cli,'workers':workers,'foreignStillAlive':foreign.poll() is None,'rescuePerformedBeforeObservation':False, 'mode':mode}
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
    if mode == 'rescue-siblings':
        assert remaining, 'The original unhooked test must leave work for observer rescue'
    else:
        assert not remaining, f'Owned resources survived driver cleanup: {remaining}'
    assert result['foreignStillAlive'], 'Foreign sentinel unexpectedly stopped'
    if mode != 'rescue-siblings':
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
    def attempt(action, *args, **kwargs):
        try:
            return action(*args, **kwargs)
        except Exception as error:
            errors.append(repr(error))

    if p is not None:
        def discover():
            remember(table(), p.pid)

        def freeze_cli():
            if current(cli) is not None:
                freeze_tree(cli, 'complete-rescue-inventory.json')

        attempt(discover)
        if cli:
            attempt(freeze_cli)
            attempt(send, cli, signal.SIGKILL)
        for w in workers:
            leader = identities.get(w['pgid'])
            if leader:
                attempt(send, leader, signal.SIGKILL, leader=True, token=w['token'])
        for _ in range(2):
            for record in list(identities.values()):
                if record['pid'] != p.pid:
                    attempt(send, record, signal.SIGKILL)
        if p.poll() is None:
            record = identities.get(p.pid)
            if record:
                attempt(send, record, signal.SIGKILL)
        attempt(p.wait, timeout=5)
        reap(p)
    if foreign is not None:
        try:
            alive_before = foreign.poll() is None
            save('foreign-preserved-through-rescue.json',{'alive':alive_before,'identity':foreign_identity})
            if not alive_before:
                raise RuntimeError('Foreign sentinel was not preserved through rescue')
        except Exception as error:
            errors.append(repr(error))
        finally:
            reap(foreign)
    time.sleep(.5)
    rows = []
    remaining = None
    try:
        rows = table()
        remaining = remaining_owned(rows) + [r for r in rows if live(r) and foreign is not None and r['pid'] == foreign.pid]
    except Exception as error:
        errors.append(repr(error))
    save('cleanup.json', {'signals': receipts, 'refused': refused, 'errors': errors, 'remaining': remaining, 'processInspectionSucceeded': remaining is not None, 'identities': list(identities.values()), 'unverified': list(unverified.values()), 'transitions': transitions, 'foreignPid': foreign.pid if foreign else None})
    save('processes-after.json', [r for r in rows if r['pid'] in identities or (foreign is not None and r['pid'] == foreign.pid)])
    if errors or remaining is None or remaining:
        raise RuntimeError('Cleanup incomplete; inspect cleanup.json')
