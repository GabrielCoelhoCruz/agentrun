"""One bounded production CLI run. Private output. Never retry paid calls."""
import errno, fcntl, hashlib, json, os, pathlib, pty, select, signal, struct, subprocess, sys, termios, time
if os.environ.get('AGENTRUN_E2E_REAL') != '1':
 raise SystemExit('Set AGENTRUN_E2E_REAL=1 to authorize one paid run')
if len(sys.argv) != 3:
 raise SystemExit('Usage: python3 run-report-e2e.py <node24> <new-private-directory>')
root = pathlib.Path(sys.argv[2]).resolve()
root.mkdir(mode=0o700)
repo = root / 'repo'; repo.mkdir()
node = str(pathlib.Path(sys.argv[1]).resolve())
checkout = pathlib.Path(__file__).resolve().parents[3]
bin = str(checkout / 'packages/cli/dist/bin.mjs')
def capture(name, args, cwd=repo, timeout=30):
 r = subprocess.run(args,cwd=cwd,capture_output=True,text=True,timeout=timeout)
 (root / (name+'.private.json')).write_text(json.dumps({'command':args,'cwd':str(cwd),'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2))
 if r.returncode: raise RuntimeError(name+' failed; inspect private output')
 return r.stdout
capture('init',['git','init','-b','main'])
capture('git-config',['git','config','commit.gpgsign','false'])
(repo/'.gitignore').write_text('.agentrun/\n')
(repo/'TASKS.md').write_text('''---
base: main
concurrency: 1
---
## claude-task: Claude file
agent: claude-code
maxTurns: 3
maxBudgetUsd: 0.25

Write claude-result.txt containing exactly "claude-ok" using the Write tool. Do not run other tools. Reply done.

## pi-task: Pi file
agent: pi
model: openai/gpt-6-astra

Write pi-result.txt containing exactly "pi-ok" using the write tool. Do not run other tools. Reply done.
''')
capture('add',['git','add','TASKS.md','.gitignore'])
capture('base-commit',['git','-c','user.name=Integration Test','-c','user.email=test@example.invalid','commit','-m','test: prepare report tasks'])
base = capture('base-sha',['git','rev-parse','HEAD']).strip()
capture('doctor',[node,bin,'doctor','--json'])
model = capture('model',[node,'--input-type=module','-e', '''import {ModelRuntime,getAgentDir} from '@earendil-works/pi-coding-agent'; import {join} from 'node:path'; const dir=getAgentDir(); const r=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json')}); const m=r.getAvailableSnapshot().find(m=>m.provider==='openai'&&m.id==='gpt-6-astra'); if(!m)throw Error('openai/gpt-6-astra unavailable'); console.log(JSON.stringify({provider:m.provider,id:m.id}));'''],checkout/'packages/core')
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
args=[node,bin,'run','TASKS.md','--concurrency','1']
env=dict(os.environ,TERM='xterm-256color',NO_COLOR='1')
p=subprocess.Popen(args,cwd=repo,env=env,stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
(root/'owner.private.json').write_text(json.dumps({'pid':p.pid,'launcherPid':os.getpid(),'cwd':str(repo),'command':args,'baseSHA':base,'checkout':str(checkout),'ports':[],'containers':[]},indent=2))
raw=bytearray();start=time.monotonic();interrupted=False
try:
 while True:
  elapsed=time.monotonic()-start
  if elapsed>90 and not interrupted:p.send_signal(signal.SIGINT);interrupted=True
  if elapsed>115:raise TimeoutError('Production CLI did not close after deadline interruption')
  ready,_,_=select.select([master],[],[],0.1)
  if ready:
   try:
    data=os.read(master,65536)
    if not data:break
    raw.extend(data)
   except OSError as e:
    if e.errno!=errno.EIO:raise
    break
 p.wait(timeout=10)
finally:
 (root/'panel.private.ansi').write_bytes(raw)
 if p.poll() is None:
  p.send_signal(signal.SIGINT)
  p.wait(timeout=15)
 os.close(master)
(root/'run.private.json').write_text(json.dumps({'exitCode':p.returncode,'durationSeconds':time.monotonic()-start,'deadlineInterrupted':interrupted,'command':args},indent=2))
if p.returncode:raise RuntimeError('Production CLI failed; do not retry')
statefile=next((repo/'.agentrun/runs').glob('*/state.json'))
state=json.loads(statefile.read_text());run=statefile.parent
output=capture('report-json',[node,bin,'report',state['runId'],'--json'])
report=json.loads(output)
assert report['status']==state['status']
assert 'processToken' not in output and 'pendingEvent' not in output
capture('report-markdown',[node,bin,'report',state['runId']])
proof=[]
for task in state['tasks']:
 id=task['id']; w=state['worktrees'][id];data=report['taskReports'][id]
 assert state['status'][id]['_tag']=='succeeded'
 file='claude-result.txt' if task['agent']=='claude-code' else 'pi-result.txt'
 expected='claude-ok' if task['agent']=='claude-code' else 'pi-ok'
 actual=capture(id+'-content',['git','show',w['branch']+':'+file])
 assert actual==expected,(id,actual)
 assert not pathlib.Path(w['path']).exists()
 assert data['durationMs']>0 and data['costUsd']>0 and data['result']
 patch=(run/'tasks'/id/'diff.patch').read_text();assert '+'+expected in patch
 events=[json.loads(line) for line in (run/'tasks'/id/'events.jsonl').read_text().splitlines()]
 assert events[0]['_tag']=='Started' and events[-1]['_tag']=='Completed'
 branchSHA=capture(id+'-commit',['git','rev-parse',w['branch']]).strip()
 proof.append({'task':id,'branch':w['branch'],'sha':branchSHA,'fileVerified':True,'patchVerified':True,'events':len(events),'durationMs':data['durationMs'],'costUsd':data['costUsd'],'worktreeRemoved':True})
worktrees=capture('worktrees',['git','worktree','list','--porcelain'])
assert worktrees.count('worktree ')==1
common=os.path.realpath(repo/capture('common',['git','rev-parse','--git-common-dir']).strip())
hash=hashlib.sha256(common.encode()).hexdigest()[:12]
lock=pathlib.Path.home()/'.agentrun/locks'/ (hash+'.lock');assert not lock.exists()
(root/'proof.private.json').write_text(json.dumps({'runId':state['runId'],'baseSHA':base,'tasks':proof,'lockReleased':True,'remainingWorktrees':1},indent=2))
print('Production CLI report verified')
