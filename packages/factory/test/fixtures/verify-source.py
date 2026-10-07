"""Inspect an archive without extraction and compare it with the candidate tree."""
import hashlib
import json
import subprocess
import sys
import tarfile

repo, candidate, archive = sys.argv[1:]
def git(*args):
    return subprocess.check_output(['git', '-C', repo, *args])

expected = {}
for entry in git('ls-tree', '-r', '-t', '-z', candidate).split(b'\0'):
    if not entry:
        continue
    metadata, name = entry.split(b'\t', 1)
    mode, kind, oid = metadata.decode().split()
    expected[name.decode()] = (mode, kind, oid)

seen = set()
proof = []
with tarfile.open(archive) as tar:
    for entry in tar:
        name = entry.name.rstrip('/') if entry.isdir() else entry.name
        assert name not in seen, ('duplicate', name)
        assert not name.startswith('/') and not any(p in ('', '.', '..') for p in name.split('/')), name
        assert name in expected, ('extra', name)
        seen.add(name)
        mode, kind, oid = expected[name]
        if kind == 'tree':
            assert entry.isdir(), name
            continue
        assert kind == 'blob', ('unsupported', name)
        content = git('cat-file', 'blob', oid)
        if mode == '120000':
            assert entry.issym() and entry.linkname.encode() == content, name
        else:
            assert entry.isfile() and entry.mode == int(mode, 8) & 0o777, (name, oct(entry.mode), mode)
            assert tar.extractfile(entry).read() == content, ('bytes', name)
        proof.append({'name': name, 'mode': mode, 'sha256': hashlib.sha256(content).hexdigest()})
assert seen == set(expected), ('missing', sorted(set(expected) - seen))
print(json.dumps(proof))
