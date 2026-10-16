Implement the requested behavior in server.py. Preserve the HTTP interface and the startup line.
Use only the Python standard library (http.server, json, sqlite3). Do not install packages.
The project needs Python 3.12 or newer. Keep project checks and their declared inputs unchanged.
The project check creates a note, stops the server with SIGTERM, starts it again, and reads the note after restart.
Use NOTES_DB for the SQLite path. Apply schema version 1 before printing the startup line:
table notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL) and PRAGMA user_version = 1.
Commit each note before the HTTP 201 response. Exit with code 0 on SIGTERM.
Do not publish, push, create a pull request, or change branches.
