import ctypes
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

_run = subprocess.run
_identity = ('pid', 'parent', 'group', 'uid', 'start', 'command')
_commands = {
    prefix + args for prefix in ('ps ', '/bin/ps ') for args in (
        '-axo pid=,ppid=,pgid=,stat=,command= -ww',
        '-axo pid=,ppid=,pgid=,stat=',
    )
}


def expected_uid():
    info = Path('/bin/ps').stat()
    return info.st_uid if info.st_mode & stat.S_ISUID else os.getuid()


def executable(pid):
    if sys.platform == 'darwin':
        library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        buffer = ctypes.create_string_buffer(4096)
        if library.proc_pidpath(pid, buffer, len(buffer)) <= 0:
            raise OSError(ctypes.get_errno(), 'Cannot inspect helper executable')
        return os.fsdecode(buffer.value)
    return os.readlink(f'/proc/{pid}/exe')


def inspect_pair(child, parent):
    result = _run(['/bin/ps', '-ww', '-p', f'{child},{parent}', '-o',
                   'pid=,ppid=,pgid=,uid=,ruid=,lstart=,stat=,command='],
                  capture_output=True, text=True, timeout=5)
    if result.returncode not in (0, 1) or result.stderr:
        raise RuntimeError('Helper ownership inspection failed')
    rows = []
    for line in result.stdout.splitlines():
        fields = line.split(None, 11)
        if len(fields) != 12:
            raise RuntimeError('Helper ownership inspection returned an invalid row')
        rows.append(dict(pid=int(fields[0]), parent=int(fields[1]), group=int(fields[2]),
                         uid=int(fields[3]), ruid=int(fields[4]), start=' '.join(fields[5:10]),
                         state=fields[10], command=fields[11]))
    return rows


def owned_ps(row, parent):
    if (row.get('command') not in _commands or row.get('uid') != expected_uid()
            or not isinstance(parent, dict) or parent.get('uid') != os.getuid()
            or row.get('parent') != parent.get('pid') or row.get('group') != parent.get('group')
            or 'T' not in parent.get('state', '') or os.getuid() == 0
            or '/fixtures/dist/entry.mjs ' not in parent.get('command', '')
            or not re.search(r'(?:^|\s)--conditions=agentrun-terminal-[a-f0-9]{32}(?:\s|$)', parent['command'])):
        return False
    rows = inspect_pair(row['pid'], parent['pid'])
    if len(rows) != 2 or len({r['pid'] for r in rows}) != 2:
        return False
    child = next((r for r in rows if r['pid'] == row['pid']), None)
    actual_parent = next((r for r in rows if r['pid'] == parent['pid']), None)
    if child is None or actual_parent is None:
        return False
    if any(actual.get(k) != expected.get(k) for actual, expected in [(child, row), (actual_parent, parent)] for k in _identity):
        return False
    if (child.get('ruid') != os.getuid() or actual_parent.get('ruid') != os.getuid()
            or child['state'].startswith('Z') or 'T' not in actual_parent['state']):
        return False
    return Path(executable(row['pid'])).resolve() == Path('/bin/ps').resolve()
