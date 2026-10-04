import hashlib
import inspect
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import time

wt = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve()
mode = sys.argv[2]
fields = ['pid', 'parent', 'group', 'uid', 'start', 'state', 'command']
identity_fields = ['pid', 'uid', 'group', 'start', 'command']
real_run = subprocess.run
real_kill = os.kill
real_glob = Path.glob


def save(name, value):
    (out / name).write_text(json.dumps(value, indent=2) + '\n')


def parse(text):
    rows = []
    for line in text.splitlines():
        v = line.split(None, 10)
        assert len(v) == 11, line
        rows.append(dict(pid=int(v[0]), parent=int(v[1]), group=int(v[2]), uid=int(v[3]),
                         start=' '.join(v[4:9]), state=v[9], command=v[10]))
    return rows


def table():
    return parse(real_run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,pgid=,uid=,lstart=,stat=,command='],
                          capture_output=True, text=True, check=True, timeout=8).stdout)


def same(a, b):
    return all(a[k] == b[k] for k in identity_fields)


def live(row):
    return not row['state'].startswith('Z')


def exact(record):
    row = next((r for r in table() if r['pid'] == record['pid'] and live(r)), None)
    if row is not None and not same(row, record):
        raise RuntimeError('Probe refused changed identity: ' + str(record['pid']))
    return row


def stop_owned(record, sig):
    row = exact(record)
    if row is not None:
        assert row['uid'] == os.getuid()
        real_kill(row['pid'], sig)
        with (out / 'probe-signals.jsonl').open('a') as f:
            f.write(json.dumps({'identity': row, 'signal': signal.Signals(sig).name}) + '\n')


if len(sys.argv) > 3 and sys.argv[3] == 'driver':
    guard = out / 'guard'
    state = {'armed': False, 'injected': False, 'target': None, 'deferState': False}
    registration = mode in ['worker-command', 'worker-group', 'cli-command', 'cli-group', 'initial-partial', 'launcher']

    def observed_glob(path, pattern, **kwargs):
        if state['deferState'] and pattern == '*/state.json' and str(guard) in str(path):
            state['deferState'] = False
            return iter([])
        return real_glob(path, pattern, **kwargs)


    def observed_run(args, *a, **kw):
        response = real_run(args, *a, **kw)
        caller = inspect.currentframe().f_back
        if not isinstance(args, list) or args[0] != 'ps' or caller.f_code.co_name != 'table':
            return response
        if response.returncode:
            return response
        rows = parse(response.stdout)
        owner = caller.f_globals
        save('observer-owned.json', list(owner['identities'].values()) + ([owner['foreign_identity']] if owner['foreign_identity'] else []))
        context = caller.f_back
        record = context.f_locals.get('record') if context.f_code.co_name == 'current' else None
        frozen = (guard / 'complete-fault-inventory.json').exists()
        freeze_call = any(frame.function == 'freeze_tree' for frame in inspect.stack())
        if registration and not state['armed'] and context.f_code.co_name == '<module>':
            candidates = [r for r in rows if 'fake-worker.mjs agentrun-worker-' in r['command'] and live(r)]
            cli_rows = [r for r in rows if '/fixtures/dist/entry.mjs run TASKS.md' in r['command'] and live(r)]
            leases = [r for r in rows if '/usr/bin/lockf ' in r['command'] and str(guard) in r['command']]
            if candidates and cli_rows and leases:
                cli_row = cli_rows[0]
                worker = next(r for r in candidates if r['parent'] == cli_row['pid'])
                owned = {owner['p'].pid}
                while True:
                    expanded = owned | {r['pid'] for r in rows if r['parent'] in owned}
                    if expanded == owned:
                        break
                    owned = expanded
                captured = [dict(r) for r in rows if r['pid'] in owned]
                target = cli_row if mode in ['launcher', 'cli-command', 'cli-group'] else worker
                for r in captured:
                    if r['pid'] == cli_row['pid'] or r['pid'] == worker['pid'] or r['pid'] == leases[0]['pid'] or r['parent'] == leases[0]['pid']:
                        stop_owned(r, signal.SIGSTOP)
                state.update(armed=True, target=dict(target), deferState=True)
                save('precondition.json', {'identities': captured, 'target': dict(target),
                                          'foreign': owner['foreign_identity'], 'phase': 'registration'})
                if mode == 'launcher':
                    receipt = next(guard.rglob('terminal-child-' + str(target['pid']) + '.json'))
                    launcher = json.loads(receipt.read_text())['commands'][0]
                    target['command'] = launcher
                    state['injected'] = True
                    save('injection.json', {'mode': mode, 'observed': dict(target), 'receipt': str(receipt)})
                elif mode == 'initial-partial':
                    target['command'] = '(node)'
                    state['partialUntil'] = time.monotonic() + 3
                    state['injected'] = True
                    save('injection.json', {'mode': mode, 'observed': dict(target)})
        elif registration and state['armed']:
            if mode == 'initial-partial' and time.monotonic() < state['partialUntil']:
                for row in rows:
                    if row['pid'] == state['target']['pid'] and live(row):
                        row['command'] = '(node)'
            if mode in ['worker-command', 'worker-group', 'cli-command', 'cli-group']:
                state['injected'] = True
                for row in rows:
                    if row['pid'] == state['target']['pid'] and live(row):
                        raw = dict(row)
                        if mode in ['worker-command', 'cli-command']:
                            row['command'] += ' changed-identity'
                        else:
                            row['group'] += 1
                        save('injection.json', {'mode': mode, 'raw': raw, 'observed': dict(row)})
        elif mode == 'freeze-exit' and not state['injected'] and freeze_call and record and 'fake-worker.mjs agentrun-worker-' in record['command']:
            row = next((r for r in rows if same(r, record) and live(r)), None)
            if row:
                state.update(armed=True, injected=True, target=record)
                save('precondition.json', {'identities': list(owner['identities'].values()), 'target': record,
                                          'foreign': owner['foreign_identity'], 'phase': 'freeze'})
                stop_owned(record, signal.SIGKILL)
                changed = {**row, 'command': '(node)'}
                save('injection.json', {'raw': row, 'observed': changed, 'mode': mode})
                rows = [changed if r['pid'] == row['pid'] else r for r in rows]
        elif mode != 'freeze-exit' and frozen and not state['armed']:
            records = list(owner['identities'].values())
            cli = owner['cli']
            python = next(r for r in rows if r['pid'] == cli['parent'])
            leases = [r for r in records if '/usr/bin/lockf ' in r['command']]
            assert len(leases) == 1, leases
            lease = leases[0]
            children = [r for r in records if r['parent'] == lease['pid']]
            assert len(children) == 1, children
            for r in [cli, lease, children[0]]:
                assert 'T' in exact(r)['state'], r
            assert exact(owner['foreign_identity']) is not None
            stop_owned(python, signal.SIGSTOP)
            state.update(armed=True, target=python)
            save('precondition.json', {'identities': records, 'target': python, 'leases': [lease, children[0]],
                                      'foreign': owner['foreign_identity'], 'phase': 'rescue'})
            return subprocess.CompletedProcess(args, 17, '', 'planned failure after complete inventory\n')
        elif state['armed'] and mode != 'freeze-exit':
            target = state['target']
            matches = record is not None and record['pid'] == target['pid']
            if (matches or mode == 'remember-command') and not state['injected']:
                state['injected'] = True
                raw = next((r for r in rows if r['pid'] == target['pid'] and live(r)), None)
                assert raw and same(raw, target), (raw, target)
                if mode == 'exit':
                    stop_owned(target, signal.SIGKILL)
                if mode == 'inspect':
                    save('injection.json', {'raw': raw, 'mode': mode, 'error': 'injected per-record inspection failure'})
                    return subprocess.CompletedProcess(args, 19, '', 'injected per-record inspection failure\n')
                save('injection.json', {'raw': raw, 'mode': mode})
            if state['injected'] and mode not in ['inspect', 'lookup']:
                for row in rows:
                    if row['pid'] != target['pid'] or not live(row):
                        continue
                    original = dict(row)
                    if mode in ['command', 'remember-command', 'exit']:
                        row['command'] = '(Python)'
                    elif mode == 'uid':
                        row['uid'] += 1
                    elif mode == 'group':
                        row['group'] += 1
                    elif mode == 'start':
                        row['start'] = 'Thu Jan 1 00:00:00 1970'
                    else:
                        raise AssertionError(mode)
                    with (out / 'observations.jsonl').open('a') as f:
                        f.write(json.dumps({'raw': original, 'observed': row}) + '\n')
        response.stdout = '\n'.join(' '.join(str(r[k]) for k in fields) for r in rows) + '\n'
        return response

    def observed_kill(pid, sig):
        if state['armed'] and state['injected'] and state['target'] and pid == state['target']['pid'] and mode == 'lookup':
            stop_owned(state['target'], signal.SIGKILL)
            end = time.monotonic() + 3
            while exact(state['target']) is not None and time.monotonic() < end:
                time.sleep(.01)
            raise ProcessLookupError('injected exit between inspection and signal')
        with (out / 'observer-signals.jsonl').open('a') as f:
            f.write(json.dumps({'pid': pid, 'signal': signal.Signals(sig).name,
                               'afterInjection': state['injected']}) + '\n')
        return real_kill(pid, sig)

    Path.glob = observed_glob
    subprocess.run = observed_run
    os.kill = observed_kill
    sys.argv = [str(wt / 'scripts/verify-terminal-cleanup.py'), str(guard), 'timeout-outer']
    runpy.run_path(sys.argv[0], run_name='__main__')
    raise SystemExit(0)

assert mode in ['exit', 'command', 'remember-command', 'uid', 'group', 'start', 'inspect', 'lookup', 'freeze-exit', 'worker-command', 'worker-group', 'cli-command', 'cli-group', 'initial-partial', 'launcher']
out.mkdir(exist_ok=False)
save('target.json', {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=wt, text=True).strip(),
                     'mode': mode, 'dirty': subprocess.check_output(['git', 'status', '--porcelain'], cwd=wt, text=True),
                     'sources': {p: hashlib.sha256((wt / p).read_bytes()).hexdigest() for p in [
                         'scripts/verify-terminal-cleanup.py', 'scripts/verify-terminal-exit-race.py',
                         'packages/cli/test/Terminal.test.ts']}})
p = None
records = []
try:
    with (out / 'guard.log').open('w') as log:
        p = subprocess.Popen([sys.executable, __file__, str(out), mode, 'driver'], cwd=wt,
                             stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        save('driver-handle.json', {'pid': p.pid, 'args': p.args})
        code = p.wait(timeout=150)
    pre = json.loads((out / 'precondition.json').read_text())
    records = pre['identities'] + [pre['target'], pre['foreign']]
    assert (out / 'injection.json').exists(), 'Fault was not reached'
    rows = table()
    save('actual-after.json', rows)
    remaining = [r for r in rows if live(r) and any(same(r, old) for old in records)]
    cleanup = json.loads((out / 'guard/cleanup.json').read_text())
    persistent = mode in ['command', 'remember-command', 'uid', 'group', 'start', 'worker-command', 'worker-group', 'cli-command', 'cli-group']
    signals = [json.loads(line) for line in (out / 'observer-signals.jsonl').read_text().splitlines()]
    target_signals = [r for r in signals if r['afterInjection'] and r['pid'] == pre['target']['pid']]
    save('result.json', {'guardExit': code, 'remainingBeforeProbeRescue': remaining,
                         'targetSignalsAfterInjection': target_signals,
                         'probeRescueBeforeObservation': False, 'persistentAmbiguity': persistent})
    assert all(not r['identity']['command'].startswith('(') for r in cleanup['signals'] if 'identity' in r), 'Partial observation became signal authority'
    assert all(r['pid'] > 0 for r in signals), 'Broad signal sent'
    if mode not in ['inspect', 'launcher', 'initial-partial']:
        assert not target_signals, 'Observer signaled an ambiguous or exited target'
    if mode not in ['inspect', 'lookup', 'launcher', 'initial-partial']:
        assert cleanup['refused'], 'Injected refusal was not recorded'
    if persistent:
        assert code != 0
        assert {r['pid'] for r in remaining} <= {pre['target']['pid']}, 'Other verified resources survived'
        if remaining:
            assert any(r['pid'] == pre['target']['pid'] for r in cleanup['remaining']), 'Live ambiguity omitted from cleanup'
        if mode not in ['worker-command', 'worker-group', 'cli-command', 'cli-group']:
            assert remaining, 'Persistent held-process precondition was lost'
    else:
        assert not remaining, 'Verified resources survived a refused or disappearing identity'
        assert not cleanup['remaining'], 'Observer did not prove absence'
    assert json.loads((out / 'guard/foreign-preserved-through-rescue.json').read_text())['alive']
    if mode in ['freeze-exit', 'launcher', 'initial-partial']:
        assert code == 0, 'An exited child prevented a complete fault inventory'
    print('PASS', mode, flush=True)
finally:
    if not records and (out / 'precondition.json').exists():
        pre = json.loads((out / 'precondition.json').read_text())
        records = pre['identities'] + [pre['target'], pre['foreign']]
    if (out / 'observer-owned.json').exists():
        records += json.loads((out / 'observer-owned.json').read_text())
    if (out / 'guard/cleanup.json').exists():
        records += json.loads((out / 'guard/cleanup.json').read_text())['identities']
    errors = []
    seen = set()
    for record in records:
        key = tuple(record[k] for k in identity_fields)
        if key in seen:
            continue
        seen.add(key)
        try:
            stop_owned(record, signal.SIGKILL)
        except Exception as error:
            errors.append(repr(error))
    if p is not None:
        if p.poll() is None:
            p.kill()
        p.wait(timeout=5)
    time.sleep(.3)
    rows = table()
    ancestors = {os.getpid()}
    while True:
        parents = {r['parent'] for r in rows if r['pid'] in ancestors}
        if parents <= ancestors:
            break
        ancestors |= parents
    remaining = [r for r in rows if live(r) and (r['pid'] in {old['pid'] for old in records}
                 or str(out) in r['command']) and r['pid'] not in ancestors]
    save('safety-rescue.json', {'errors': errors, 'remaining': remaining, 'identities': records})
    assert not remaining, 'Probe safety cleanup incomplete'
