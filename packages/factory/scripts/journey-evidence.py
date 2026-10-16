"""Keep public journey evidence small and separate from private provider data."""

import base64
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
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


def number(value, maximum=1000000):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum else None


def integer(value, maximum):
    return value if type(value) is int and 0 <= value <= maximum else None


def enum(value, values):
    return value if isinstance(value, str) and value in values else None


def summarize(work, out, code, records, trusted):
    def save(name, value):
        write(out / name, json.dumps(value, indent=2, allow_nan=False) + "\n")

    for name in ("start.json", "decide.json", "export.json"):
        state = load(work / name)
        review = state.get("review") or {}
        save(name, {
            "stage": enum(state.get("stage"), STAGES),
            "candidate": digest((state.get("candidate") or {}).get("commit"), 40),
            "costUsd": number(state.get("costUsd")),
            "durationMs": integer(state.get("durationMs"), 86400000),
            "reviewVerdict": enum(review.get("verdict"), {"accepted", "revision-needed", "human-needed"}),
            "findingCount": integer(len(review.get("findings", [])), 10000),
            "manifestDigest": digest((state.get("export") or {}).get("manifestDigest")),
        })

    receipt = (load(work / "export.json").get("export") or {})
    directory = receipt.get("directory")
    manifest = load(Path(directory) / "manifest.json") if directory else {}
    save("manifest-digests.json", {
        "manifestDigest": digest(receipt.get("manifestDigest")),
        "fileDigests": [digest(file.get("digest")) for file in manifest.get("files", [])],
    })
    # Check programs write workspace files. Publish only the wrapper's exit result.
    exits = parse_exits(records)
    save("check-result.json", {
        "version": 1,
        "candidate": digest((load(work / "start.json").get("candidate") or {}).get("commit"), 40),
        "criteria": [{"outcome": "pass" if exits.get("independent-check") == "0" else
                      "not-run" if exits.get("independent-check") in (None, "missing-source") else "fail"}],
    })
    write(out / "exits.txt", records.rstrip("\n") + "\n")
    save("toolchain.txt", {name: trusted.get(name) for name in ("nodeVersion", "pythonVersion")})
    head = digest(trusted.get("factoryHead"), 40)
    write(out / "factory-head.txt", (head or "unavailable") + "\n")
    write(out / "report.txt", "RESULT PASS\n" if code == 0 else "RESULT FAIL\n")


def parse_exits(text):
    values = {}
    for line in text.splitlines():
        if not line:
            continue
        match = re.fullmatch(r"(start|decide|export|independent-check|negative-control)=([0-9]{1,3}|missing-source)|patch=(equal|DIFFERENT)", line)
        if not match:
            raise EvidenceError("Invalid exit record")
        name, value = line.split("=", 1)
        if name in values or (value.isdigit() and int(value) > 255):
            raise EvidenceError("Invalid exit record")
        values[name] = value
    return values


def validate(contents):
    def require(condition):
        if not condition:
            raise EvidenceError("Invalid evidence schema; publication blocked")

    def fields(value, names):
        require(isinstance(value, dict) and set(value) == set(names.split()))

    def nullable(value, validated):
        require(value is None or validated is not None)

    for name in ("start.json", "decide.json", "export.json"):
        value = json.loads(contents[name])
        fields(value, "stage candidate costUsd durationMs reviewVerdict findingCount manifestDigest")
        nullable(value["stage"], enum(value["stage"], STAGES))
        nullable(value["candidate"], digest(value["candidate"], 40))
        nullable(value["costUsd"], number(value["costUsd"]))
        nullable(value["durationMs"], integer(value["durationMs"], 86400000))
        nullable(value["reviewVerdict"], enum(value["reviewVerdict"], {"accepted", "revision-needed", "human-needed"}))
        nullable(value["findingCount"], integer(value["findingCount"], 10000))
        nullable(value["manifestDigest"], digest(value["manifestDigest"]))
    value = json.loads(contents["toolchain.txt"])
    fields(value, "nodeVersion pythonVersion")
    for name, prefix in [("nodeVersion", "v"), ("pythonVersion", "")]:
        version = value[name]
        require(version is None or (isinstance(version, str) and re.fullmatch(prefix + r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}", version)))
    value = json.loads(contents["manifest-digests.json"])
    fields(value, "manifestDigest fileDigests")
    nullable(value["manifestDigest"], digest(value["manifestDigest"]))
    require(isinstance(value["fileDigests"], list) and len(value["fileDigests"]) <= 1024)
    for entry in value["fileDigests"]:
        nullable(entry, digest(entry))
    value = json.loads(contents["check-result.json"])
    fields(value, "version candidate criteria")
    require(type(value["version"]) is int and value["version"] == 1)
    nullable(value["candidate"], digest(value["candidate"], 40))
    require(isinstance(value["criteria"], list) and len(value["criteria"]) <= 1024)
    for item in value["criteria"]:
        fields(item, "outcome")
        require(enum(item["outcome"], {"pass", "fail", "not-run"}) is not None)
    parse_exits(contents["exits.txt"].decode())
    head = contents["factory-head.txt"].decode()
    require(head == "unavailable\n" or (head.endswith("\n") and digest(head[:-1], 40) is not None))
    require(contents["report.txt"] in (b"RESULT PASS\n", b"RESULT FAIL\n"))


def file_commands(action):
    if action == "snapshot":
        values = []
        for name in ("GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH"):
            path = os.environ.get(name)
            if path:
                file = Path(path)
                if file.is_symlink() or (file.exists() and not file.is_file()):
                    raise EvidenceError("Invalid Actions command file")
                data = file.read_bytes() if file.exists() else b""
                values.append({"path": path, "exists": file.exists(), "size": len(data),
                               "data": base64.b64encode(data).decode()})
        print(json.dumps(values))
        return 0
    changed = False
    for value in json.load(sys.stdin):
        file = Path(value["path"])
        original = base64.b64decode(value["data"])
        if file.is_symlink() or (file.exists() and not file.is_file()):
            changed = True
        elif (file.exists() != value["exists"] or
              (file.exists() and (file.stat().st_size != value["size"] or file.read_bytes() != original))):
            changed = True
            if value["exists"]:
                file.write_bytes(original)
            elif file.exists():
                file.unlink()
    return 1 if changed else 0


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
    validate(contents)
    return contents


def summary(out):
    contents = scan(out)
    report = contents["report.txt"]
    if report not in (b"RESULT PASS\n", b"RESULT FAIL\n"):
        raise EvidenceError("Invalid journey result; publication blocked")
    data = b"### Real provider journey\n\n" + report
    check_secret(data)
    sys.stdout.buffer.write(data)


def isolated_git(native, args):
    # These journey commands do not use transports, editors or pagers. Disable
    # the program hooks used by local reads, writes, commits and worktree setup.
    fixed = ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
             "-c", "core.attributesFile=/dev/null", "-c", "commit.gpgSign=false",
             "-c", "tag.gpgSign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"]
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_ATTR_NOSYSTEM="1", GIT_NO_LAZY_FETCH="1")
    index = 0
    while index < len(args) and args[index].startswith("-"):
        option = args[index]
        index += 2 if option in ("-c", "-C", "--git-dir", "--work-tree", "--config-env") else 1
    # Reading config cannot run its configured programs. Replace every filter
    # driver before add/checkout can use candidate attributes to select it.
    config = subprocess.run([native, *args[:index], *fixed, "config", "--includes", "--null", "--name-only", "--list"],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    filters = []
    if config.returncode not in (0, 128):
        return 1
    for entry in config.stdout.decode().split("\0"):
        name = entry
        if re.fullmatch(r"filter\.[\s\S]+\.(clean|smudge|process|required)", name):
            filters += ["-c", name + ("=false" if name.endswith(".required") else "=")]
    command = args[index:index + 1]
    flags = ["--no-ext-diff", "--no-textconv"] if command and command[0] in ("diff", "show", "log") else []
    return subprocess.call([native, *args[:index], *fixed, *filters, *command, *flags, *args[index + 1:]], env=env)


def main():
    action = sys.argv[1]
    if action == "git-shim":
        path = Path(sys.argv[2]) / "git"
        path.write_text("#!/usr/bin/env bash\nexec python3 " + shlex.quote(str(Path(__file__).resolve())) +
                        " git " + shlex.quote(shutil.which("git")) + ' "$@"\n')
        path.chmod(0o700)
    elif action == "git":
        return isolated_git(sys.argv[2], sys.argv[3:])
    elif action == "toolchain":
        env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
        head = subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                                        "-C", sys.argv[2], "rev-parse", "HEAD"], env=env, text=True).strip()
        print(json.dumps({"nodeVersion": subprocess.check_output(["node", "-v"], text=True).strip(),
                          "pythonVersion": ".".join(map(str, sys.version_info[:3])), "factoryHead": head}))
    elif action == "file-commands":
        return file_commands(sys.argv[2])
    elif action == "capture":
        # Capture both streams in private files. Neither stream reaches the Actions log.
        # Children can run provider tools. Keep CI file commands, runtime tokens,
        # and upload endpoints in the trusted wrapper, outside that process tree.
        env = {name: value for name, value in os.environ.items()
               if not name.startswith(("GITHUB_", "ACTIONS_", "RUNNER_", "GH_", "INPUT_"))}
        result = subprocess.run(sys.argv[4:], cwd=sys.argv[3], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        Path(sys.argv[2]).write_bytes(redact(result.stdout))
        Path(sys.argv[2] + ".stderr").write_bytes(redact(result.stderr))
        return result.returncode if result.returncode >= 0 else 1
    elif action == "summarize":
        trusted = sys.stdin.read()
        summarize(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]),
                  sys.argv[5] if len(sys.argv) > 5 else "", json.loads(trusted) if trusted else {})
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
