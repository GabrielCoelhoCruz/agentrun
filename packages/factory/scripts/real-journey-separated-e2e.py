"""Linux CLI proof: write boundaries, /proc, object links, and surviving children."""

import json
import os
from pathlib import Path
import pwd
import subprocess
import sys

factory = Path(__file__).resolve().parents[3]
root = Path(sys.argv[1]).resolve()
user = sys.argv[2]
uid = pwd.getpwnam(user).pw_uid
root.mkdir(mode=0o755)
root.chmod(0o755)
key = "fake-review-key-0123456789-abcdefgh"
source = (factory / "packages/factory/test/fixtures/provider-hooks.mjs").read_text()
# Keep the reviewer's original tamper payload: rewrite the shim and helper.
attack = r"""
  const attack = process.env.FACTORY_FIXTURE_JOURNEY_ATTACK;
  if (!task.stage.startsWith('review')) {
    record({kind:'attack-started', attack});
    const hex = Buffer.from(process.env.ANTHROPIC_API_KEY).toString('hex');
    const work = join(process.env.HOME, '..', '..');
    if (attack === 'tamper') {
      const shim = join(work, 'tools', 'git');
      const real = readFileSync(shim, 'utf8');
      writeFileSync(shim, '#!/usr/bin/env bash\necho "SHIM-LOG ' + hex + '" >&3 2>/dev/null\necho "INJECTED=' + hex + '" >> "$GITHUB_ENV"\n' + real.split('\n').slice(1).join('\n'));
      const helper = join(work, 'control', 'journey-evidence.py');
      const orig = readFileSync(helper, 'utf8');
      writeFileSync(helper, orig.replace('def file_commands(action):', 'def file_commands(action):\n    if action != "snapshot":\n        sys.stdin.read(); return 0'));
    }
    if (attack === 'checkout') {
      for (const file of ['packages/factory/dist/bin.mjs', 'packages/factory/scripts/journey-evidence.py']) {
        assert.throws(() => writeFileSync(join(process.env.FACTORY_FIXTURE_FACTORY, file), hex), /EACCES|EPERM/);
      }
      throw new Error('checkout attack blocked');
    }
    if (attack === 'proc') {
      let pid = process.ppid;
      let blocked = false;
      for (let i = 0; i < 16 && pid; i++) {
        try { readFileSync('/proc/' + pid + '/environ'); }
        catch (error) { assert.match(error.code, /EACCES|EPERM|ENOENT/); blocked = true; break; }
        pid = Number((spawnSync('ps', ['-p',String(pid),'-o','ppid='], {encoding:'utf8'}).stdout || '').trim());
      }
      assert.ok(blocked, 'runner ancestor environment must be inaccessible');
      record({kind:'proc-blocked'});
      throw new Error('proc attack blocked');
    }
    if (attack === 'objects') {
      symlinkSync('/etc/passwd', join(process.env.FACTORY_FIXTURE_TARGET, '.git/objects/linked'));
    }
    if (attack === 'background') {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true, stdio:'ignore'});
      child.unref();
      record({kind:'background-child',pid:child.pid});
    }
  }
"""
marker = "  record({ kind: 'provider', stage: task.stage,"
assert marker in source
hook = root / "hook.mjs"
hook.write_text(source.replace(marker, json.dumps(attack)[1:-1].replace('`', r'\`').replace('${', r'\${') + '\n' + marker))
hook.chmod(0o644)
results = []
for attack in ["happy", "tamper", "checkout", "proc", "objects", "background"]:
    case = root / attack
    case.mkdir(mode=0o755)
    case.chmod(0o755)
    private = case / "agent-log"
    subprocess.run(["sudo", "install", "-d", "-m", "700", "-o", user, str(private)], check=True)
    supplied = dict(os.environ, ANTHROPIC_API_KEY=key, NODE_OPTIONS="--import=" + hook.as_uri(),
                    FACTORY_FIXTURE_MODE="happy", FACTORY_FIXTURE_SOURCE="server.ts",
                    FACTORY_FIXTURE_DURABLE=str(factory / "packages/factory/test/fixtures/server-durable.ts"),
                    FACTORY_FIXTURE_LOG=str(private / "providers.jsonl"),
                    FACTORY_FIXTURE_JOURNEY_ATTACK=attack, FACTORY_FIXTURE_FACTORY=str(factory),
                    PYTHONDONTWRITEBYTECODE="1", FACTORY_JOURNEY_FIXTURE="1")
    originals = {}
    for name in ["GITHUB_STEP_SUMMARY", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH"]:
        path = case / name
        originals[name] = b"existing=value\n"
        path.write_bytes(originals[name])
        path.chmod(0o600)
        supplied[name] = str(path)
    command = ["bash", "packages/factory/scripts/real-journey.sh", "--factory", str(factory),
               "--out", str(case / "public"), "--id", "separated-" + attack, "--agent-user", user]
    run = subprocess.run(command, cwd=factory, env=supplied, capture_output=True, text=True, timeout=300)
    (case / "journey.log").write_text(run.stdout + run.stderr)
    print(f"{attack}: journey exit={run.returncode}; stdout={run.stdout!r}; stderr={run.stderr!r}", flush=True)
    provider_log = subprocess.run(["sudo", "cat", str(private / "providers.jsonl")], capture_output=True, text=True)
    log = provider_log.stdout
    if provider_log.returncode:
        print(f"{attack}: provider log exit={provider_log.returncode}; stderr={provider_log.stderr!r}", flush=True)
    (case / "providers.jsonl").write_text(log)
    expected = 0 if attack in ["happy", "background"] else 1
    checks = {"exit": run.returncode == expected,
              "fixed-log": run.stdout == ("RESULT PASS\n" if expected == 0 else "RESULT FAIL\n"),
              "no-key": key not in run.stdout + run.stderr and key.encode().hex() not in run.stdout + run.stderr,
              "probe-ran": '"kind":"attack-started"' in log,
              "processes-stopped": subprocess.run(["pgrep", "-u", str(uid)], capture_output=True).returncode == 1}
    for name, original in originals.items():
        checks[name] = Path(supplied[name]).read_bytes() == original
    if attack == "proc": checks["proc-blocked"] = '"kind":"proc-blocked"' in log
    if attack == "background": checks["child-created"] = '"kind":"background-child"' in log
    public = case / "public"
    scan = subprocess.run(["python3", str(factory / "packages/factory/scripts/journey-evidence.py"), "scan", str(public)],
                          env=supplied, capture_output=True, text=True)
    checks["scan"] = scan.returncode == 0
    checks["report"] = (public / "report.txt").read_text() == ("RESULT PASS\n" if expected == 0 else "RESULT FAIL\n")
    if expected == 0:
        exits = (public / "exits.txt").read_text()
        checks["patch-rebuilt"] = "patch=derived\n" in exits
        checks["independent-and-negative"] = "independent-check=0\nnegative-control=1\n" in exits
    results.append({"attack": attack, "command": command, "cwd": str(factory), "exit": run.returncode,
                    "expected": expected, "checks": checks, "passed": all(checks.values())})
    (root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"{'PASS' if all(checks.values()) else 'FAIL'} {attack}: {checks}", flush=True)
sys.exit(0 if all(row["passed"] for row in results) else 1)
