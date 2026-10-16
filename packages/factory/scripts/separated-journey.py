"""Trusted Linux harness. Provider and check code run under a different UID."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time

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
    for name in ("factory", "out", "id", "agent-user"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--example", default="examples/factory/notes-ts")
    parser.add_argument("--check", default="")
    parser.add_argument("--goal", default="Store a note and read it after restart")
    parser.add_argument("--budget", type=float, default=4)
    args = parser.parse_args()
    require(sys.platform == "linux")
    account = pwd.getpwnam(args.agent_user)
    uid = account.pw_uid
    require(uid != 0 and uid != os.getuid())
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
    tools = work / "tools"
    control = work / "control"
    for directory in (agent, tools, control):
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)
    helper = control / "journey-evidence.py"
    shutil.copyfile(Path(__file__).with_name("journey-evidence.py"), helper)
    helper.chmod(0o644)
    # No provider-controlled PATH, Python imports, Node options, Git config or HOME
    # are inherited by trusted commands. Every subprocess has closed extra FDs.
    trusted_env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "LANG": "C.UTF-8",
                   "PYTHONDONTWRITEBYTECODE": "1", "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_ATTR_NOSYSTEM": "1", "GIT_NO_LAZY_FETCH": "1"}
    native_git = shutil.which("git", path=trusted_env["PATH"])
    node = shutil.which("node", path=trusted_env["PATH"])
    python = sys.executable
    sudo = shutil.which("sudo", path=trusted_env["PATH"])
    require(native_git and node and sudo)
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
        result = subprocess.run([sudo, "-n", "pkill", "-KILL", "-u", str(uid)], env=trusted_env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(result.returncode in (0, 1))
        for _ in range(50):
            result = subprocess.run(["pgrep", "-u", str(uid)], env=trusted_env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode == 1:
                return
            require(result.returncode == 0)
            time.sleep(0.1)
        raise RuntimeError("Agent processes remain")

    def git(*argv):
        return trusted([native_git, "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                        "-c", "core.attributesFile=/dev/null", "-c", "commit.gpgSign=false", "-c", "gc.auto=0",
                        "-c", "maintenance.auto=false", *map(str, argv)])

    def run_agent(command, cwd, name, secret=True, extra=None):
        env = {"HOME": str(agent / "home"), "TMPDIR": str(agent / "tmp"), "PATH": str(tools) + ":" + trusted_env["PATH"],
               "LANG": "C.UTF-8", "USER": account.pw_name, "LOGNAME": account.pw_name,
               "XDG_CONFIG_HOME": str(agent / "home/.config"), "XDG_CACHE_HOME": str(agent / "home/.cache"),
               "CLAUDE_CONFIG_DIR": str(agent / "home/.claude"), "PI_CODING_AGENT_DIR": str(agent / "home/.pi"),
               "PYTHONDONTWRITEBYTECODE": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
               "GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null",
               "GIT_CONFIG_KEY_1": "core.fsmonitor", "GIT_CONFIG_VALUE_1": "false"}
        if secret:
            env["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_API_KEY"]
            # Only the fixture proof enables trusted hooks. Paid runs set none.
            if os.environ.get("FACTORY_JOURNEY_FIXTURE") == "1":
                for key in ("NODE_OPTIONS", "FACTORY_FIXTURE_MODE", "FACTORY_FIXTURE_SOURCE", "FACTORY_FIXTURE_DURABLE",
                            "FACTORY_FIXTURE_LOG", "FACTORY_FIXTURE_JOURNEY_ATTACK", "FACTORY_FIXTURE_FACTORY"):
                    if key in os.environ:
                        env[key] = os.environ[key]
                env["FACTORY_FIXTURE_TARGET"] = str(target)
        env.update(extra or {})
        result = subprocess.run([sudo, "-n", "-u", account.pw_name, "env", "-i",
                                 *[f"{key}={value}" for key, value in env.items()],
                                 python, "-I", str(control / "agent-exec.py"), str(cwd), *command],
                                env=trusted_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # Keep raw streams private; never execute or print their contents.
        (work / name).write_bytes(evidence.redact(result.stdout))
        (work / (name + ".stderr")).write_bytes(evidence.redact(result.stderr))
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
        # Verify effective access as the agent, including real symlink targets
        # and ancestors. This catches writable checkout parents and toolchains.
        checkpoint = "permissions"
        boundary = control / "boundary.py"
        boundary.write_text('''import os, pathlib, sys
for root in sys.argv[1:]:
    paths = [pathlib.Path(root)]
    if paths[0].is_dir():
        paths += list(paths[0].rglob('*'))
    for entry in paths:
        resolved = entry.resolve()
        for path in [resolved, *resolved.parents]:
            try:
                mode = path.stat().st_mode
            except PermissionError:
                continue
            # Sticky world-writable ancestors cannot replace another user's entries.
            sticky = path.is_dir() and mode & 0o1000 and path.stat().st_uid != os.getuid()
            if os.access(path, os.W_OK) and not sticky:
                print("Agent can write trusted path:", path, file=sys.stderr)
                sys.exit(1)
''')
        boundary.chmod(0o644)
        trusted([sudo, "-n", "-u", account.pw_name, "env", "-i", "PATH=" + trusted_env["PATH"],
                 python, "-I", str(boundary), str(factory), node, native_git, python, str(control), str(tools),
                 *map(str, channels)])
        checkpoint = "sudo-authority"
        # Agent must not have sudo authority, even through runner group membership.
        result = subprocess.run([sudo, "-n", "-u", account.pw_name, sudo, "-n", "true"],
                                env=trusted_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(result.returncode != 0)
        require(subprocess.run(["pgrep", "-u", str(uid)], capture_output=True).returncode == 1)
        checkpoint = "setup"
        trusted_values = {"nodeVersion": trusted([node, "-v"]).decode().strip(),
                          "pythonVersion": ".".join(map(str, sys.version_info[:3])),
                          "factoryHead": git("-C", factory, "rev-parse", "HEAD").decode().strip()}
        launcher = control / "agent-exec.py"
        launcher.write_text("import os, sys\nos.chdir(sys.argv[1])\nos.execvpe(sys.argv[2], sys.argv[2:], os.environ)\n")
        launcher.chmod(0o644)
        # Runner-owned shim is readable/executable but cannot be changed by agent.
        shim = tools / "git"
        import shlex
        shim.write_text("#!/bin/sh\nexec " + shlex.quote(python) + " -I " + shlex.quote(str(helper)) +
                        " git " + shlex.quote(native_git) + ' "$@"\n')
        shim.chmod(0o755)
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
        for directory in (agent / "home", agent / "tmp"):
            directory.mkdir()
        agent.chmod(0o700)
        trusted([sudo, "-n", "chown", "-R", f"{uid}:{account.pw_gid}", str(agent)])
        bin_path = str(factory / "packages/factory/dist/bin.mjs")
        checkpoint = "factory-start"
        status = run_agent([node, bin_path, "start", "--profile", "factory.json", "--goal", args.goal,
                            "--id", args.id, "--json"], target, "start.json")
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
                           target, "decide.json")
        record("decide", status)
        require(status == 0)
        states["decide.json"] = read_json(work / "decide.json")
        require(states["decide.json"].get("stage") == "approved")
        checkpoint = "export"
        status = run_agent([node, bin_path, "export", args.id, "--json"], target, "export.json")
        record("export", status)
        require(status == 0)
        states["export.json"] = read_json(work / "export.json")
        require(states["export.json"].get("stage") == "exported")
        checkpoint = "stop-and-copy"
        # End the whole agent UID before any trusted read of its repository.
        stop()
        trusted([sudo, "-n", "chown", "-R", f"{os.getuid()}:{os.getgid()}", str(agent)])
        trusted(["chmod", "-R", "u+rwX", str(agent)])
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
        trusted([sudo, "-n", "chown", "-R", f"{uid}:{account.pw_gid}", str(agent)])
        checkpoint = "checks"
        for name, directory, commit, artifacts in [("independent-check", "src", candidate, "artifacts"),
                                                    ("negative-control", "base", base, "base-artifacts")]:
            source = verify / directory
            result = run_agent(check["argv"], source / check["cwd"], name + ".log", secret=False,
                               extra={"FACTORY_ARTIFACT_DIR": str(verify / artifacts), "FACTORY_RESULT": str(verify / (name + ".json")),
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
            if isinstance(error, subprocess.CalledProcessError) and checkpoint == "permissions":
                print(error.stderr.decode(errors="replace"), file=sys.stderr)
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
            # Agent cannot write the parent or public directory. Root only removes
            # this task's private tree, after its UID has no live processes.
            trusted([sudo, "-n", "rm", "-rf", "--", str(work)])
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
