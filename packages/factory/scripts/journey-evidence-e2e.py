"""Exercise the public evidence CLI against real files and child processes."""

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

# Failures: encoded/split/partial credentials, raw tool text, inherited publication
# channels, unsafe summaries, and missing/unreadable/linked/large/nested artifacts.
helper = Path(__file__).with_name("journey-evidence.py")
good, root = map(Path, sys.argv[1:3])
root.mkdir()
secret = "sk-ant-fake-review-key-0123456789-abcdefgh_?"
env = dict(os.environ, ANTHROPIC_API_KEY=secret)
results = []


def run(name, args, expected, extra=None):
    result = subprocess.run(["python3", str(helper), *map(str, args)], env=extra or env,
                            capture_output=True, text=True, timeout=20)
    passed = result.returncode == expected
    results.append({"name": name, "command": ["python3", str(helper), *map(str, args)],
                    "expected": expected, "code": result.returncode, "passed": passed,
                    "stdout": result.stdout, "stderr": result.stderr})
    print(f"{'PASS' if passed else 'FAIL'} {name}: exit {result.returncode}, expected {expected}", flush=True)
    return result


variants = {
    "exact": secret,
    "url": "".join(f"%{byte:02X}" for byte in secret.encode()),
    "url-mixed": secret.replace("-", "%2d"),
    "hex": secret.encode().hex(),
    "hex-upper": secret.encode().hex().upper(),
    "hex-mixed": "".join(char.upper() if index % 3 else char for index, char in enumerate(secret.encode().hex())),
    "split": "\n \t".join(secret[i:i+8] for i in range(0, len(secret), 8)),
    "partial-prefix": secret[:24],
    "partial-middle": secret[12:28],
}
for offset in range(3):
    for name, encode in [("base64", base64.b64encode), ("base64url", base64.urlsafe_b64encode)]:
        variants[f"{name}-{offset}"] = encode(b"x" * offset + secret.encode() + b"tail").decode()
for name, value in variants.items():
    target = root / name
    shutil.copytree(good, target)
    (target / "report.txt").write_text(value + "\n")
    run(name, ["scan", target], 1)
    # The trusted summary writer must scan before emitting even one byte.
    result = run(f"summary-{name}", ["summary", target], 1)
    assert result.stdout == "", name

for kind in ["missing-file", "missing-dir", "empty-key", "read-error", "root-link", "file-link", "large", "nested", "extra"]:
    target = root / kind
    shutil.copytree(good, target)
    supplied = dict(env)
    if kind == "missing-file": (target / "start.json").unlink()
    if kind == "missing-dir": shutil.rmtree(target)
    if kind == "empty-key": supplied["ANTHROPIC_API_KEY"] = ""
    if kind == "read-error": (target / "report.txt").chmod(0)
    if kind == "root-link":
        shutil.rmtree(target)
        target.symlink_to(good, target_is_directory=True)
    if kind == "file-link":
        (target / "report.txt").unlink()
        (target / "report.txt").symlink_to(good / "report.txt")
    if kind == "large": (target / "report.txt").write_text("x" * 65537)
    if kind == "nested":
        (target / "nested").mkdir()
        (target / "report.txt").rename(target / "nested/report.txt")
    if kind == "extra": (target / "agent.log").write_text("raw agent text")
    run(kind, ["scan", target], 1, supplied)
    if kind == "read-error": (target / "report.txt").chmod(0o600)

# Copy unstructured provider-controlled inputs into private work, then call the
# actual serializer. Arbitrary text must disappear even without a known secret.
work, public = root / "private", root / "structured"
work.mkdir()
public.mkdir()
(work / "toolchain.txt").write_text("node v24.21.0\nPython 3.12.0\nPROVIDER_FREE_TEXT\n" + variants["base64-0"])
(work / "factory-head.txt").write_text("PROVIDER_FREE_TEXT\n")
run("structured-generation", ["summarize", work, public, "1"], 0)
raw = b"".join(path.read_bytes() for path in public.iterdir())
for name, token in [("raw-tool-output", b"PROVIDER_FREE_TEXT"), ("encoded-tool-output", variants["base64-0"].encode())]:
    passed = token not in raw
    results.append({"name": name, "passed": passed})
    print(f"{'PASS' if passed else 'FAIL'} {name}")
run("structured-scan", ["scan", public], 0)
summary = run("summary-safe", ["summary", good], 0)
passed = summary.stdout == "### Real provider journey\n\nRESULT PASS\n"
results.append({"name": "summary-fixed-content", "passed": passed})

channels = {name: str(root / name) for name in ["GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STATE"]}
channels.update({name: "fixture-token" for name in ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_CACHE_URL", "ACTIONS_RESULTS_URL", "GITHUB_TOKEN", "GH_TOKEN", "RUNNER_TEMP", "INPUT_TOKEN"]})
captured = root / "captured.json"
child = "import json,os; print(json.dumps(sorted(k for k in os.environ if k.startswith(('GITHUB_', 'ACTIONS_', 'GH_', 'RUNNER_', 'INPUT_')))))"
run("scrubbed-child", ["capture", captured, root, "python3", "-c", child], 0, dict(env, **channels))
passed = json.loads(captured.read_text()) == []
results.append({"name": "publication-environment", "passed": passed})
print(f"{'PASS' if passed else 'FAIL'} publication-environment")
(root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
sys.exit(0 if all(row["passed"] for row in results) else 1)
