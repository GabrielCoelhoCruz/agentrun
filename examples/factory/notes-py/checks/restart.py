import json
import os
import selectors
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

artifacts = os.environ.get("FACTORY_ARTIFACT_DIR")
if not artifacts:
    raise SystemExit("FACTORY_ARTIFACT_DIR is required")
artifacts = Path(artifacts)
database = artifacts / "notes.sqlite"
children = []
transcript = []


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read_line(child, timeout=10):
    data = b""
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while b"\n" not in data:
            remaining = deadline - time.monotonic()
            require(remaining > 0 and selector.select(remaining), "Server did not report its address")
            chunk = os.read(child.stdout.fileno(), 4096)
            require(chunk != b"", f"Server exited before readiness: {child.poll()}")
            data += chunk
    return json.loads(data.split(b"\n", 1)[0])


def request(origin, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json"}
    try:
        with urllib.request.urlopen(urllib.request.Request(origin + path, data, headers), timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read())


def start():
    child = subprocess.Popen(
        [sys.executable, "-I", "-B", "server.py"],
        env={**os.environ, "NOTES_DB": str(database)},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        bufsize=0,
    )
    children.append(child)
    address = read_line(child)
    require(address.get("pid") == child.pid, "Server reported a different process")
    origin = f"http://127.0.0.1:{address['port']}"
    status, readiness = request(origin, "/ready")
    require(status == 200 and readiness == {"ready": True, "schema": 1}, f"Wrong readiness: {readiness}")
    transcript.append({"event": "ready", **address, "readiness": readiness})
    return child, origin


def stop(child):
    if child.poll() is not None:
        return
    child.terminate()
    try:
        code = child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        raise
    require(code == 0, f"Server exited with {code} after SIGTERM")
    transcript.append({"event": "stopped", "pid": child.pid})


outcome = "fail"
try:
    runtime = json.loads(Path("runtime.json").read_text())
    minimum = tuple(int(part) for part in runtime["pythonMinimum"].split("."))
    require(sys.version_info[: len(minimum)] >= minimum, f"Python {runtime['pythonMinimum']} or newer is required")
    transcript.append({"event": "runtime", "python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version})
    first, origin = start()
    status, created = request(origin, "/notes", {"text": "A note that survives restart"})
    require(status == 201, f"Expected HTTP 201, got {status}")
    require(created.get("text") == "A note that survives restart", f"Wrong created note: {created}")
    transcript.append({"event": "created", "note": created})
    stop(first)
    second, origin = start()
    require(first.pid != second.pid, "Restart must use a new process")
    status, restored = request(origin, f"/notes/{created['id']}")
    require(status == 200, "The created note must survive a server restart")
    require(restored == created, f"Restored note differs: {restored}")
    transcript.append({"event": "read-after-restart", "note": restored})
    stop(second)
    with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as db:
        require(db.execute("PRAGMA user_version").fetchone()[0] == 1, "Schema version must be 1")
        row = db.execute("SELECT text FROM notes WHERE id = ?", (int(created["id"]),)).fetchone()
        require(row == (created["text"],), f"Stored row differs: {row}")
    db.close()
    transcript.append({"event": "migration-verified", "version": 1})
    outcome = "pass"
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
            child.wait()
        child.stdout.close()
    (artifacts / "journey.json").write_text(json.dumps(transcript, indent=2))
    Path(os.environ["FACTORY_RESULT"]).write_text(json.dumps({
        "version": 1,
        "attemptId": os.environ.get("FACTORY_ATTEMPT_ID"),
        "candidate": os.environ.get("FACTORY_CANDIDATE"),
        "checkId": os.environ.get("FACTORY_CHECK_ID"),
        "criteria": [{"id": "persisted-note", "outcome": outcome, "artifacts": ["journey.json"]}],
    }))
