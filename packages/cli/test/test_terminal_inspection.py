import copy
import os
import sys
import unittest
from unittest.mock import patch

import terminal_inspection as helper


class HelperAuthority(unittest.TestCase):
    def setUp(self):
        self.parent = dict(pid=222, parent=111, group=111, uid=os.getuid(), start='Mon Oct 5 01:10:01 2026',
                           state='T', command='node --conditions=agentrun-terminal-' + 'a' * 32 + ' /repo/packages/cli/test/fixtures/dist/entry.mjs run TASKS.md')
        self.child = dict(pid=333, parent=222, group=111, uid=helper.expected_uid(), start='Mon Oct 5 01:10:02 2026',
                          state='S', command='ps -axo pid=,ppid=,pgid=,stat=,command= -ww')
        self.rows = [dict(self.parent, ruid=os.getuid()), dict(self.child, ruid=os.getuid())]

    def check(self, child=None, parent=None, rows=None, path='/bin/ps'):
        with patch.object(helper, 'inspect_pair', return_value=self.rows if rows is None else rows), \
                patch.object(helper, 'executable', return_value=path):
            return helper.owned_ps(self.child if child is None else child, self.parent if parent is None else parent)

    def test_owned_helper_and_live_wait_states(self):
        for state in ['R', 'S', 'U', 'T']:
            child = dict(self.child, state=state)
            rows = [self.rows[0], dict(self.rows[1], state=state)]
            self.assertTrue(self.check(child=child, rows=rows))

    def test_real_uid_and_effective_uid_are_separate(self):
        for uid in [0, os.getuid() + 1, None]:
            rows = copy.deepcopy(self.rows)
            rows[1]['ruid'] = uid
            self.assertFalse(self.check(rows=rows))
        for key in ['uid', 'pid', 'parent', 'group', 'start', 'command']:
            rows = copy.deepcopy(self.rows)
            rows[1][key] = str(rows[1][key]) + ' changed'
            self.assertFalse(self.check(rows=rows))
        rows = copy.deepcopy(self.rows)
        del rows[1]['ruid']
        self.assertFalse(self.check(rows=rows))

    def test_parent_authority_and_nonce(self):
        for key, value in [('uid', 0), ('state', 'S'), ('command', 'node fake'), ('pid', 223), ('group', 1)]:
            parent = dict(self.parent, **{key: value})
            self.assertFalse(self.check(parent=parent))
        for key in ['uid', 'pid', 'parent', 'group', 'start', 'command']:
            rows = copy.deepcopy(self.rows)
            rows[0][key] = str(rows[0][key]) + ' changed'
            self.assertFalse(self.check(rows=rows))

    def test_exact_executable_and_arguments(self):
        self.assertFalse(self.check(path='/tmp/ps'))
        for command in ['ps fake', self.child['command'] + ' extra', '(ps)', '/tmp/' + self.child['command']]:
            self.assertFalse(self.check(child=dict(self.child, command=command)))
        self.assertFalse(self.check(child=dict(self.child, parent=999)))
        self.assertFalse(self.check(child=dict(self.child, group=999)))

    def test_missing_duplicate_or_exited_rows(self):
        for rows in [[], [self.rows[0]], self.rows + [self.rows[1]], [self.rows[0], dict(self.rows[1], state='Z')]]:
            self.assertFalse(self.check(rows=rows))

    def test_inspection_errors_remain_visible(self):
        with patch.object(helper, 'inspect_pair', side_effect=RuntimeError('unreadable')):
            with self.assertRaisesRegex(RuntimeError, 'unreadable'):
                helper.owned_ps(self.child, self.parent)


if __name__ == '__main__':
    unittest.main()
