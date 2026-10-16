"""Trusted Linux harness. Agent and check code run only inside Docker."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

container_spec = importlib.util.spec_from_file_location("journey_container", Path(__file__).with_name("journey_container.py"))
container_module = importlib.util.module_from_spec(container_spec)
container_spec.loader.exec_module(container_module)
Container = container_module.Container

spec = importlib.util.spec_from_file_location("journey_evidence", Path(__file__).with_name("journey-evidence.py"))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


def require(condition):
    if not condition:
        raise RuntimeError("Journey boundary failed")


def read_json(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 * 1024)
    value = json.loads(path.read_bytes())
    require(isinstance(value, dict))
    return value


def member(value, name):
    result = value.get(name, {})
    require(isinstance(result, dict))
    return result


def sha(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ("factory", "out", "id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--example", default="examples/factory/notes-ts")
    parser.add_argument("--check", default="")
    parser.add_argument("--goal", default="Store a note and read it after restart")
    parser.add_argument("--budget", type=float, default=4)
    args = parser.parse_args()
    require(sys.platform == "linux")
    require(re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", args.id))
    factory = Path(args.factory).resolve()
    out = Path(args.out).absolute()
    require(not out.exists() and not out.is_symlink())
    out.mkdir(mode=0o755)
    out.chmod(0o755)
    work = out / ".private"
    work.mkdir(mode=0o755)
    work.chmod(0o755)
    agent = work / "agent"
    target = agent / "target"
    agent.mkdir(mode=0o700)
    trusted_env = {"PATH": container_module.PATH, "HOME": str(work), "LANG": "C.UTF-8",
                   "PYTHONDONTWRITEBYTECODE": "1", "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_ATTR_NOSYSTEM": "1", "GIT_NO_LAZY_FETCH": "1"}
    native_git = "/usr/bin/git"
    container = None
    records = ""
    states = {}
    channels = {}
    code = 1
    manifest = {"manifestDigest": None, "fileDigests": []}
    candidate = None
    verified = False
    checkpoint = "publication-files"

    def trusted(command, **kwargs):
        return subprocess.run(command, env=trusted_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              check=True, **kwargs).stdout

    def record(name, value):
        nonlocal records
        records += f"{name}={value}\n"

    def stop():
        if container is not None:
            container.stop()

    def git(*argv):
        return trusted([native_git, "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                        "-c", "core.attributesFile=/dev/null", "-c", "commit.gpgSign=false", "-c", "gc.auto=0",
                        "-c", "maintenance.auto=false", *map(str, argv)])

    def run_agent(command, cwd, name, extra=None):
        result = container.run(command, cwd, extra)
        # Raw streams stay private. Paid output never reaches host logs.
        (work / name).write_bytes(evidence.redact(result.stdout))
        (work / (name + ".stderr")).write_bytes(evidence.redact(result.stderr))
        if os.environ.get("FACTORY_JOURNEY_FIXTURE") == "1" and result.returncode:
            diagnostic = evidence.redact(result.stderr)[:4096]
            try:
                evidence.check_secret(diagnostic)
            except evidence.EvidenceError:
                diagnostic = b"Credential-bearing fixture stderr withheld"
            print(f"Fixture {name}: exit={result.returncode}; stderr={diagnostic.decode(errors='replace')!r}", file=sys.stderr)
        return result.returncode if result.returncode >= 0 else 1

    try:
        # Snapshot every publication file, including an existing summary.
        channel_names = {"GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STEP_SUMMARY"}
        channel_names.update(name for name, value in os.environ.items()
                             if name.startswith("GITHUB_") and value.startswith("/")
                             and (Path(value).is_file() or Path(value).is_symlink()))
        for name in sorted(channel_names):
            if name in os.environ:
                path = Path(os.environ[name])
                require(not path.is_symlink() and path.is_file() and path.stat().st_uid == os.getuid())
                path.chmod(0o600)
                channels[path] = path.read_bytes()
        checkpoint = "setup"
        trusted_values = {"nodeVersion": None,
                          "pythonVersion": ".".join(map(str, sys.version_info[:3])),
                          "factoryHead": git("-C", factory, "rev-parse", "HEAD").decode().strip()}
        example = Path(args.example)
        if not example.is_absolute():
            example = factory / example
        shutil.copytree(example, target)
        profile_path = target / "factory.json"
        profile = read_json(profile_path)
        profile["limits"]["providerBudgetUsd"] = args.budget
        profile["limits"]["durationMs"] = 2700000
        profile_path.write_text(json.dumps(profile, indent=2) + "\n")
        check_id = args.check or profile["acceptance"][0]["check"]
        check = next(value for value in profile["checks"] if value["id"] == check_id)
        require(isinstance(check["argv"], list) and all(isinstance(arg, str) for arg in check["argv"]))
        require(isinstance(check["cwd"], str) and not Path(check["cwd"]).is_absolute() and ".." not in Path(check["cwd"]).parts)
        git("-C", target, "init", "-q", "-b", "main")
        git("-C", target, "add", "-A")
        git("-C", target, "-c", "user.name=factory", "-c", "user.email=factory@localhost", "commit", "-qm", "chore: starter")
        base = git("-C", target, "rev-parse", "HEAD").decode().strip()
        container = Container(factory, work / "control", agent, os.environ)
        container.start()
        node = "/usr/local/bin/node"
        trusted_values["nodeVersion"] = container.run([node, "-v"], "/work").stdout.decode().strip()
        bin_path = "/factory/packages/factory/dist/bin.mjs"
        checkpoint = "factory-start"
        status = run_agent([node, bin_path, "start", "--profile", "factory.json", "--goal", args.goal,
                            "--id", args.id, "--json"], "/work/target", "start.json")
        record("start", status)
        states["start.json"] = read_json(work / "start.json")
        state = states["start.json"]
        checkpoint = "request"
        request = member(state, "request")
        candidate = member(state, "candidate").get("commit")
        request_id = request.get("id")
        evidence_digest = request.get("evidenceDigest")
        version = request.get("expectedVersion")
        require(status == 0 and state.get("stage") == "human" and "approve" in request.get("allowedActions", []))
        require(evidence.digest(candidate, 40) and evidence.digest(evidence_digest))
        require(isinstance(request_id, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,200}", request_id))
        require(evidence.integer(version, 1000000) is not None)
        checkpoint = "decide"
        status = run_agent([node, bin_path, "decide", args.id, "--request", request_id, "--candidate", candidate,
                            "--evidence", evidence_digest, "--expected-version", str(version), "--action", "approve", "--json"],
                           "/work/target", "decide.json")
        record("decide", status)
        require(status == 0)
        states["decide.json"] = read_json(work / "decide.json")
        require(states["decide.json"].get("stage") == "approved")
        checkpoint = "export"
        status = run_agent([node, bin_path, "export", args.id, "--json"], "/work/target", "export.json")
        record("export", status)
        require(status == 0)
        states["export.json"] = read_json(work / "export.json")
        require(states["export.json"].get("stage") == "exported")
        checkpoint = "stop-and-copy"
        # Remove the whole PID namespace before reading agent repository bytes.
        stop()
        objects = target / ".git/objects"
        require(not target.is_symlink() and not (target / ".git").is_symlink() and not objects.is_symlink())
        # Copy bytes only. Reject symlinks, alternates, special files and hardlinks;
        # never import config, hooks, refs, attributes or an agent export path.
        repo = work / "evidence.git"
        git("init", "-q", "--bare", repo)
        for entry in objects.rglob("*"):
            rel = entry.relative_to(objects)
            metadata = entry.lstat()
            require(not stat.S_ISLNK(metadata.st_mode))
            if stat.S_ISDIR(metadata.st_mode):
                require(str(rel) in ("info", "pack") or re.fullmatch(r"[0-9a-f]{2}", str(rel)))
                continue
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1)
            require(re.fullmatch(r"[0-9a-f]{2}/[0-9a-f]{38}|pack/pack-[0-9a-f]{40}\.(pack|idx)", str(rel)))
            require(metadata.st_size <= 100 * 1024 * 1024)
            destination = repo / "objects" / rel
            destination.parent.mkdir(exist_ok=True)
            shutil.copyfile(entry, destination)
        git("--git-dir", repo, "fsck", "--strict", "--no-reflogs", base, candidate)
        git("--git-dir", repo, "merge-base", "--is-ancestor", base, candidate)
        verified = True

        def checkout(commit, destination):
            destination.mkdir()
            digests = []
            entries = git("--git-dir", repo, "ls-tree", "-rz", "--full-tree", commit).split(b"\0")
            require(len(entries) <= 1025)
            for row in filter(None, entries):
                metadata, raw_name = row.split(b"\t", 1)
                mode, kind, oid = metadata.decode().split()
                name = raw_name.decode()
                path = Path(name)
                require(kind == "blob" and mode in ("100644", "100755") and not path.is_absolute()
                        and ".." not in path.parts and ".git" not in path.parts)
                data = git("--git-dir", repo, "cat-file", "blob", oid)
                require(len(data) <= 16 * 1024 * 1024)
                file = destination / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
                file.chmod(0o755 if mode == "100755" else 0o644)
                digests.append({"name": name, "digest": sha(data)})
            return digests

        checkpoint = "materialize"
        verify = agent / "verify"
        verify.mkdir()
        files = checkout(candidate, verify / "src")
        checkout(base, verify / "base")
        # Check commands are pinned by the runner's original profile. Check source
        # must match the starter as well, independent of the factory's claims.
        require(git("--git-dir", repo, "diff", "--no-ext-diff", "--no-textconv", base, candidate,
                    "--", "checks", "factory.json") == b"")
        patch = git("--git-dir", repo, "diff", "--no-ext-diff", "--no-textconv", "--binary", base, candidate)
        manifest_bytes = json.dumps({"base": base, "candidate": candidate, "files": files,
                                     "patchDigest": sha(patch)}, sort_keys=True, separators=(",", ":")).encode()
        manifest = {"manifestDigest": sha(manifest_bytes), "fileDigests": [file["digest"] for file in files]}
        record("patch", "derived")
        for name in ("artifacts", "base-artifacts"):
            (verify / name).mkdir()
        container = Container(factory, work / "check-control", agent, {})
        container.start(secret=False)
        checkpoint = "checks"
        for name, directory, commit, artifacts in [("independent-check", "src", candidate, "artifacts"),
                                                    ("negative-control", "base", base, "base-artifacts")]:
            source = Path("/work/verify") / directory
            result = run_agent(check["argv"], str(source / check["cwd"]), name + ".log",
                               extra={"FACTORY_ARTIFACT_DIR": "/work/verify/" + artifacts, "FACTORY_RESULT": "/work/verify/" + name + ".json",
                                      "FACTORY_ATTEMPT_ID": name, "FACTORY_CANDIDATE": commit, "FACTORY_CHECK_ID": check_id,
                                      "FACTORY_RUN_ID": args.id, "FACTORY_WORKSPACE": str(source)})
            record(name, result)
        require("independent-check=0\n" in records and "negative-control=0\n" not in records)
        code = 0
    except Exception as error:
        # Diagnostics are enabled only for the fake-key fixture proof. Do not
        # print exception messages, command arguments, or provider output.
        if os.environ.get("FACTORY_JOURNEY_FIXTURE") == "1":
            print(f"Fixture failure at {checkpoint}: {type(error).__name__}", file=sys.stderr)
        code = 1
    finally:
        stopped = False
        try:
            stop()
            stopped = True
            for path, original in channels.items():
                require(not path.is_symlink() and path.is_file())
                if path.read_bytes() != original:
                    path.write_bytes(original)
                    code = 1
            # Generate from bounded fields only. Agent export paths and manifest
            # digests are discarded; published digests come from copied objects.
            for name in ("start.json", "decide.json", "export.json"):
                value = states.get(name, {})
                review = value.get("review")
                review = review if isinstance(review, dict) else {}
                findings = review.get("findings")
                clean = {"stage": evidence.enum(value.get("stage"), evidence.STAGES),
                         "candidate": {"commit": candidate if verified else None},
                         "costUsd": evidence.number(value.get("costUsd")),
                         "durationMs": evidence.integer(value.get("durationMs"), 86400000),
                         "review": {"verdict": evidence.enum(review.get("verdict"), {"accepted", "revision-needed", "human-needed"}),
                                    "findings": [None] * min(len(findings), 10000) if isinstance(findings, list) else []},
                         "export": {"manifestDigest": manifest["manifestDigest"]}}
                (work / name).write_text(json.dumps(clean))
            evidence.summarize(work, out, code, records, locals().get("trusted_values", {}))
            evidence.write(out / "manifest-digests.json", json.dumps(manifest, indent=2) + "\n")
            # No agent process can change files during validation or cleanup.
            shutil.rmtree(work)
            evidence.scan(out)
        except Exception:
            code = 1
        if not stopped:
            # Never permit publication when process cleanup could not be proved.
            (out / "report.txt").write_text("RESULT FAIL\n")
            (out / "unsafe-processes").write_text("Publication blocked\n")
    print("RESULT PASS" if code == 0 else "RESULT FAIL")
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("RESULT FAIL")
        sys.exit(1)
