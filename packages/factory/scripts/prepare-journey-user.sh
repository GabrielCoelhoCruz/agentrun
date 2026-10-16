#!/usr/bin/env bash
# GitHub Ubuntu runner only. Run before passing any provider credentials.
set -euo pipefail

[ "${GITHUB_ACTIONS:-}" = true ]
[ "$(uname -s)" = Linux ]
sudo useradd --no-create-home --user-group --shell /usr/sbin/nologin agentrun-agent
chmod -R a+rX,go-w "$GITHUB_WORKSPACE"
# Hosted tool caches can be world-writable. Protect executable bytes, libraries,
# and their parent directories before letting the unprivileged user run them.
node_root=$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")
python_root=$(dirname "$(dirname "$(readlink -f "$(command -v python3)")")")
[ "$node_root" != / ] && [ "$python_root" != / ]
sudo chmod -R a+rX,go-w "$node_root" "$python_root"
for root in "$GITHUB_WORKSPACE" "$RUNNER_TEMP" "$node_root" "$python_root"; do
  directory=$root
  while [ "$directory" != / ]; do
    sudo chmod go-w,o+x "$directory"
    directory=$(dirname "$directory")
  done
done
