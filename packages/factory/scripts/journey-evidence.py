"""Keep public journey evidence small and separate from private provider data."""

import base64
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote_to_bytes


ALLOWED = {
    "exits.txt", "toolchain.txt", "factory-head.txt", "start.json", "decide.json",
    "export.json", "manifest-digests.json", "check-result.json", "report.txt",
}
MAX_BYTES = 65536
STAGES = {"implement", "correct", "checks", "review", "human", "approved", "exported", "blocked", "cancelling", "cancelled", "rejected"}


class EvidenceError(Exception):
    pass


def redact(data):
    secret = os.environ.get("ANTHROPIC_API_KEY", "")
    if secret:
        for value in (secret.encode(), json.dumps(secret)[1:-1].encode()):
            data = data.replace(value, b"[REDACTED]")
    return data


def write(path, data):
    data = redact(data.encode())
    if len(data) > MAX_BYTES:
        raise EvidenceError("Evidence exceeds size limit")
    path.write_bytes(data)


def load(path):
    if not path.exists():
        return {}
    value = json.loads(path.read_bytes())
    return value if isinstance(value, dict) else {}


def digest(value, length=64):
    return value if isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{length}}}", value) else None


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def enum(value, values):
    return value if isinstance(value, str) and value in values else None


def summarize(work, out, code):
    def save(name, value):
        write(out / name, json.dumps(value, indent=2, allow_nan=False) + "\n")

    for name in ("start.json", "decide.json", "export.json"):
        state = load(work / name)
        review = state.get("review") or {}
        save(name, {
            "stage": enum(state.get("stage"), STAGES),
            "candidate": digest((state.get("candidate") or {}).get("commit"), 40),
            "costUsd": number(state.get("costUsd")),
            "durationMs": number(state.get("durationMs")),
            "reviewVerdict": enum(review.get("verdict"), {"accepted", "revision-needed", "human-needed"}),
            "findingCount": len(review.get("findings", [])),
            "manifestDigest": digest((state.get("export") or {}).get("manifestDigest")),
        })

    receipt = (load(work / "export.json").get("export") or {})
    directory = receipt.get("directory")
    manifest = load(Path(directory) / "manifest.json") if directory else {}
    save("manifest-digests.json", {
        "manifestDigest": digest(receipt.get("manifestDigest")),
        "fileDigests": [digest(file.get("digest")) for file in manifest.get("files", [])],
    })
    result = load(work / "verify/result.json")
    save("check-result.json", {
        "version": number(result.get("version")),
        "candidate": digest(result.get("candidate"), 40),
        "criteria": [{"outcome": enum(item.get("outcome"), {"pass", "fail", "not-run"})}
                     for item in result.get("criteria", [])],
    })
    # Fixed formats exclude prompts, paths, review messages, and arbitrary CLI text.
    lines = (work / "exits.txt").read_text().splitlines() if (work / "exits.txt").exists() else []
    safe = [line for line in lines if re.fullmatch(
        r"(?:start|decide|export|independent-check|negative-control)=(?:[0-9]+|missing-source)|patch=(?:equal|DIFFERENT)", line)]
    write(out / "exits.txt", "\n".join(safe) + "\n")
    versions = (work / "toolchain.txt").read_text().splitlines()
    save("toolchain.txt", {
        "nodeVersion": next((line[5:] for line in versions if re.fullmatch(r"node v[0-9]+\.[0-9]+\.[0-9]+", line)), None),
        "pythonVersion": next((line[7:] for line in versions if re.fullmatch(r"Python [0-9]+\.[0-9]+\.[0-9]+", line)), None),
    })
    head = digest((work / "factory-head.txt").read_text().strip(), 40)
    write(out / "factory-head.txt", (head or "unavailable") + "\n")
    write(out / "report.txt", "RESULT PASS\n" if code == 0 else "RESULT FAIL\n")


def check_secret(data):
    secret = os.environ.get("ANTHROPIC_API_KEY", "").encode()
    if not secret:
        raise EvidenceError("Secret scan requires ANTHROPIC_API_KEY")
    private = secret.removeprefix(b"sk-ant-")
    patterns = {secret}
    patterns.update(private[index:index + 16] for index in range(len(private) - 15))
    for offset in range(3):
        # Keep only complete base64 characters made from secret bytes. Adjacent
        # bytes and padding must not affect a match in a larger encoded string.
        start, end = (offset * 8 + 5) // 6, (offset + len(secret)) * 8 // 6
        for encode in (base64.b64encode, base64.urlsafe_b64encode):
            patterns.add(encode(b"\0" * offset + secret)[start:end])
    for value in (data, unquote_to_bytes(data)):
        compact = re.sub(rb"\s+", b"", value)
        if secret.hex().encode() in compact.lower() or any(pattern and pattern in compact for pattern in patterns):
            raise EvidenceError("Secret detected; upload blocked")


def scan(out):
    check_secret(b"")
    if out.is_symlink() or not out.is_dir():
        raise EvidenceError("Evidence directory is missing or linked")
    entries = list(out.rglob("*"))
    contents = {}
    for path in entries:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
            raise EvidenceError("Evidence must contain small regular files only")
        contents[path.name] = path.read_bytes()
        check_secret(contents[path.name])
        check_secret(path.name.encode())
    if {path.name for path in entries} != ALLOWED or len(entries) != len(ALLOWED):
        raise EvidenceError("Evidence contains missing or unapproved files")
    return contents


def summary(out):
    contents = scan(out)
    report = contents["report.txt"]
    if report not in (b"RESULT PASS\n", b"RESULT FAIL\n"):
        raise EvidenceError("Invalid journey result; publication blocked")
    data = b"### Real provider journey\n\n" + report
    check_secret(data)
    sys.stdout.buffer.write(data)


def main():
    action = sys.argv[1]
    if action == "capture":
        # Capture in memory, redact before writing, and discard child diagnostics.
        # Children can run provider tools. Keep CI file commands, runtime tokens,
        # and upload endpoints in the trusted wrapper, outside that process tree.
        env = {name: value for name, value in os.environ.items()
               if not name.startswith(("GITHUB_", "ACTIONS_", "RUNNER_", "GH_", "INPUT_"))}
        result = subprocess.run(sys.argv[4:], cwd=sys.argv[3], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        Path(sys.argv[2]).write_bytes(redact(result.stdout))
        return result.returncode if result.returncode >= 0 else 1
    if action == "summarize":
        summarize(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]))
    elif action == "scan":
        scan(Path(sys.argv[2]))
    elif action == "summary":
        summary(Path(sys.argv[2]))
    else:
        raise EvidenceError("Unknown evidence command")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # File names, child output, and exception details can contain credentials.
        print(str(error) if isinstance(error, EvidenceError) else "Cannot prepare or scan evidence", file=sys.stderr)
        sys.exit(1)
