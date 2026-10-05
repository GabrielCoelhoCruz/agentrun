"""Driver safety checks. Invalid targets must stop before provider calls."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DRIVER = Path(__file__).with_name('run-report-e2e.py')

class TargetSafety(unittest.TestCase):
 def invoke(self, args, authorized=True):
  env = dict(os.environ)
  env.pop('AGENTRUN_E2E_REAL', None)
  if authorized: env['AGENTRUN_E2E_REAL'] = '1'
  return subprocess.run([sys.executable, str(DRIVER), *args], env=env, capture_output=True, text=True, timeout=5)
 def test_missing_target(self):
  with tempfile.TemporaryDirectory() as directory:
   output = Path(directory) / 'new-evidence'
   result = self.invoke([sys.executable, str(output)])
   self.assertNotEqual(result.returncode, 0)
   self.assertIn('<installed-cli>', result.stderr)
   self.assertFalse(output.exists())
 def test_invalid_target(self):
  with tempfile.TemporaryDirectory() as directory:
   output = Path(directory) / 'new-evidence'
   result = self.invoke([sys.executable, str(output), str(Path(directory) / 'missing.mjs')])
   self.assertNotEqual(result.returncode, 0)
   self.assertIn('CLI target does not exist', result.stderr)
   self.assertFalse(output.exists())
 def test_requires_authorization(self):
  with tempfile.TemporaryDirectory() as directory:
   output = Path(directory) / 'new-evidence'
   result = self.invoke([sys.executable, str(output), str(DRIVER)], authorized=False)
   self.assertNotEqual(result.returncode, 0)
   self.assertIn('authorize one paid run', result.stderr)
   self.assertFalse(output.exists())

if __name__ == '__main__': unittest.main()
