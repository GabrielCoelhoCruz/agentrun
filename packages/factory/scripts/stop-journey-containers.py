"""Remove only containers labelled for this workflow run, then verify removal."""
import os
import re
import subprocess

owner = os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
assert re.fullmatch(r'[0-9]+-[0-9]+', owner)
env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}
command = ['/usr/bin/docker', 'container', 'ls', '-aq', '--filter', 'label=agentrun.journey-owner=' + owner]
ids = subprocess.check_output(command, env=env).decode().split()
for identifier in ids:
    assert re.fullmatch(r'[0-9a-f]{12,64}', identifier)
    subprocess.run(['/usr/bin/docker', 'rm', '-f', identifier], env=env, check=True, capture_output=True)
assert not subprocess.check_output(command, env=env).strip(), 'Agent containers remain'
