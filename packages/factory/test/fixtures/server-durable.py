import json
import os
import re
import signal
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

database = os.environ.get("NOTES_DB")
if database is None:
    raise SystemExit("NOTES_DB is required")
db = sqlite3.connect(database)
with db:
    db.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)")
    db.execute("PRAGMA user_version = 1")


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/ready":
            self.send_json(200, {"ready": True, "schema": db.execute("PRAGMA user_version").fetchone()[0]})
            return
        match = re.fullmatch(r"/notes/(\d+)", self.path)
        row = None if match is None else db.execute("SELECT text FROM notes WHERE id = ?", (int(match[1]),)).fetchone()
        if row is None:
            self.send_json(404, {"error": "not found"})
        else:
            self.send_json(200, {"id": match[1], "text": row[0]})

    def do_POST(self):
        if self.path != "/notes":
            self.send_json(404, {"error": "not found"})
            return
        try:
            value = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        except ValueError:
            self.send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(value, dict) or not isinstance(value.get("text"), str):
            self.send_json(400, {"error": "text is required"})
            return
        with db:
            inserted = db.execute("INSERT INTO notes (text) VALUES (?)", (value["text"],))
        self.send_json(201, {"id": str(inserted.lastrowid), "text": value["text"]})

    def log_message(self, format, *args):
        pass


def stop(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
server = HTTPServer(("127.0.0.1", 0), Handler)
print(json.dumps({"port": server.server_port, "pid": os.getpid()}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    db.close()
