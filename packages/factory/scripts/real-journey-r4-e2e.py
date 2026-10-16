"""Run the journey with fixture providers that reproduce publication failures."""

import json
import os
from pathlib import Path
import subprocess
import sys

# Failures: ancestor file-command writes, executable Git config, overwritten
# versions, workspace-supplied check metadata, and invalid public schemas.
factory = Path(__file__).resolve().parents[3]
root = Path(sys.argv[1]).resolve()
root.mkdir()
key = "fake-review-key-0123456789-abcdefgh"
hook = root / "attack-hooks.mjs"
source = (factory / "packages/factory/test/fixtures/provider-hooks.mjs").read_text()
attack = r"""
  const attack = process.env.FACTORY_FIXTURE_JOURNEY_ATTACK;
  const hex = Buffer.from(process.env.ANTHROPIC_API_KEY).toString('hex');
  if (['summary', 'env', 'output', 'path'].includes(attack)) {
    const name = {summary:'GITHUB_STEP_SUMMARY',env:'GITHUB_ENV',output:'GITHUB_OUTPUT',path:'GITHUB_PATH'}[attack];
    let pid = process.pid;
    let found;
    for (let i = 0; i < 12 && pid; i++) {
      let environment;
      if (existsSync('/proc/' + pid + '/environ')) environment = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
      else environment = (spawnSync('ps', ['eww','-p',String(pid),'-o','command='], {encoding:'utf8'}).stdout || '').split(' ');
      found = environment.find(value => value.startsWith(name + '='));
      if (found) { appendFileSync(found.slice(name.length + 1), 'fixture=' + hex + '\n'); break; }
      pid = Number((spawnSync('ps', ['-p',String(pid),'-o','ppid='], {encoding:'utf8'}).stdout || '').trim());
    }
    assert.ok(found, 'fixture must recover current step path');
    record({kind:'ancestor-write', channel:name});
  }
  if (attack === 'git') {
    const command = 'sh -c "echo executed >> ' + process.env.FACTORY_FIXTURE_GIT_MARKER + '; echo ' + hex + ' >&2; exit 0" --';
    for (const name of ['diff.external', 'core.fsmonitor']) {
      const result = spawnSync('git', ['config', name, command], {cwd:options.cwd,encoding:'utf8'});
      assert.equal(result.status, 0, result.stderr);
    }
  }
  if (attack === 'version') {
    const bytes = Buffer.from(process.env.ANTHROPIC_API_KEY);
    const parts = [];
    for (let i = 0; i < bytes.length; i += 12) parts.push(BigInt('0x' + bytes.subarray(i,i+12).toString('hex')).toString());
    assert.equal(parts.length, 3);
    writeFileSync(join(process.env.HOME, '..', 'toolchain.txt'), 'node v' + parts.join('.') + '\nPython 3.12.0\n');
  }
"""
# The hook is a template string; JSON escaping preserves its generated source.
marker = "  record({ kind: 'provider', stage: task.stage,"
assert marker in source
hook.write_text(source.replace(marker, json.dumps(attack)[1:-1].replace('`', r'\`').replace('${', r'\${') + '\n' + marker))
env = dict(os.environ, ANTHROPIC_API_KEY=key,
           NODE_OPTIONS="--import=" + hook.as_uri(), FACTORY_FIXTURE_MODE="happy",
           FACTORY_FIXTURE_DURABLE=str(factory / "packages/factory/test/fixtures/server-durable.ts"),
           FACTORY_FIXTURE_SOURCE="server.ts",
           FACTORY_FIXTURE_ECHO_SECRET="1", PYTHONDONTWRITEBYTECODE="1")
results = []
versions = {"nodeVersion": subprocess.check_output(["node", "-v"], text=True).strip(),
            "pythonVersion": subprocess.check_output(["python3", "--version"], text=True).strip().removeprefix("Python ")}
for attack in ["summary", "env", "output", "path", "git", "version"]:
    case = root / attack
    case.mkdir()
    supplied = dict(env, FACTORY_FIXTURE_JOURNEY_ATTACK=attack,
                    FACTORY_FIXTURE_LOG=str(case / "providers.jsonl"),
                    FACTORY_FIXTURE_GIT_MARKER=str(case / "git-executed"))
    for name in ["GITHUB_STEP_SUMMARY", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH"]:
        path = case / name
        path.write_text("" if name == "GITHUB_STEP_SUMMARY" else "existing=value\n")
        supplied[name] = str(path)
    command = ["bash", "packages/factory/scripts/real-journey.sh", "--factory", str(factory),
               "--out", str(case / "public"), "--id", "round4-" + attack]
    result = subprocess.run(command, cwd=factory, env=supplied, capture_output=True, text=True, timeout=180)
    (case / "journey.log").write_text(result.stdout + result.stderr)
    expected = 1 if attack in ["env", "output", "path"] else 0
    checks = {"exit": result.returncode == expected,
              "summary-empty": (case / "GITHUB_STEP_SUMMARY").read_bytes() == b"",
              "fixed-log": result.stdout in ["RESULT PASS\n", "RESULT FAIL\n"] and result.stderr == ""}
    if attack in ["summary", "env", "output", "path"]:
        checks["probe-ran"] = '"kind":"ancestor-write"' in (case / "providers.jsonl").read_text()
    for name in ["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH"]:
        checks[name] = (case / name).read_text() == "existing=value\n"
    if attack == "git": checks["git-not-executed"] = not (case / "git-executed").exists()
    if attack == "version": checks["versions"] = json.loads((case / "public/toolchain.txt").read_text()) == versions
    checks["report"] = (case / "public/report.txt").read_text() == ("RESULT PASS\n" if expected == 0 else "RESULT FAIL\n")
    results.append({"name": attack, "command": command, "cwd": str(factory), "code": result.returncode,
                    "expected": expected, "checks": checks, "passed": all(checks.values())})
    (root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"{'PASS' if all(checks.values()) else 'FAIL'} {attack}: exit {result.returncode}, expected {expected}; {checks}", flush=True)
sys.exit(0 if all(row["passed"] for row in results) else 1)
