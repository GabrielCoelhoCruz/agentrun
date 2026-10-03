from pathlib import Path
import hashlib,json,os,subprocess,tarfile,sys
root=Path(sys.argv[1]).resolve();consumer=Path(sys.argv[2]).resolve();node=os.environ['NODE24'];cli=consumer/'node_modules/agentrun/dist/bin.mjs';repo=root/'repo';home=root/'home'
repo.mkdir();home.mkdir()
commands=[]
def run(name,args,cwd=repo):
 env=dict(os.environ)
 if name=='resume':env['HOME']=str(home.resolve())
 p=subprocess.run([str(a) for a in args],cwd=cwd,capture_output=True,env=env)
 record={'name':name,'command':[str(a) for a in args],'cwd':str(cwd),'exit':p.returncode,'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace')};commands.append(record);(root/'consumer-commands.private.json').write_text(json.dumps(commands,indent=2))
 if p.returncode:raise RuntimeError(name+' failed; inspect private output')
 return p.stdout
run('init',['git','init','-b','main']);(repo/'.gitignore').write_text('.agentrun/\n');(repo/'seed').write_text('base\n');(repo/'TASKS.md').write_text('## bytes: Preserve exact bytes\nWrite deterministic files.\n');run('add',['git','add','.']);run('base',['git','-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','test: consumer fixture'])
run('help',[cli,'--help']);assert run('version',[cli,'--version']).strip()==b'agentrun v0.1.0';doctor=json.loads(run('doctor',[cli,'doctor','--json']));assert doctor['complete']
parsed=json.loads(run('dry-run',[cli,'run','TASKS.md','--dry-run','--json']));assert parsed['_tag']=='DryRun' and len(parsed['tasks'])==1
run('core-runtime',[node,consumer/'installed-core-e2e.mjs',repo,home],consumer)
statefile=repo/'.agentrun/runs/consumer-demo/state.json';state=json.loads(statefile.read_text());saved=statefile.parent
report=json.loads(run('report',[cli,'report','consumer-demo','--json']));assert report['status']['bytes']['_tag']=='succeeded';assert 'processToken' not in json.dumps(report) and 'pendingEvent' not in json.dumps(report)
patch=saved/'tasks/bytes/diff.patch';commit=state['taskReports']['bytes']['deliveryCommit'];assert patch.read_bytes()==run('exact-patch',['git','diff','--binary',state['baseSha']+'..'+commit]);assert hashlib.sha256(patch.read_bytes()).hexdigest()==state['taskReports']['bytes']['patchSha256']
archive=run('archive',['git','archive',state['baseSha']]);(root/'consumer-base.tar').write_bytes(archive);apply=root/'apply';apply.mkdir()
with tarfile.open(root/'consumer-base.tar') as t:t.extractall(apply,filter='data')
run('apply-check',['git','apply','--check',patch],apply);run('apply',['git','apply',patch],apply)
for name in ['latin.txt','binary.dat']:assert (apply/name).read_bytes()==run('committed-'+name,['git','show',commit+':'+name])
assert not Path(state['worktrees']['bytes']['path']).exists();assert run('worktrees',['git','worktree','list','--porcelain']).count(b'worktree ')==1
assert not list((home/'.agentrun/locks').glob('*.lock'));assert not list((home/'.agentrun/git').rglob('*.json'))
def hashes():return {str(p.relative_to(saved)):hashlib.sha256(p.read_bytes()).hexdigest() for p in saved.rglob('*') if p.is_file()}
before=hashes();out=run('resume',[cli,'resume','consumer-demo','--json']);assert json.loads(out)['_tag']=='RunFinished';assert hashes()==before
(root/'consumer-proof.private.json').write_text(json.dumps({'installedCLI':str(cli),'baseSHA':state['baseSha'],'deliveryCommit':commit,'exactPatch':True,'appliedExactBytes':True,'resumeUnchanged':True,'providerCalls':0,'syntheticAdapterCalls':1,'worktreesRemoved':True,'lockReleased':True,'gitJournalsEmpty':True,'artifactHashes':before},indent=2))
print('Installed consumer E2E passed')
