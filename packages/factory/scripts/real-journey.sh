#!/usr/bin/env bash
# Runs one factory journey against a fresh copy of an example and checks the exported delivery independently.
# The profile's providers make real, paid calls unless NODE_OPTIONS injects a fixture provider.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: real-journey.sh --factory <checkout> --out <new-dir> --id <workflow-id>
                       [--example <dir>] [--check <check-id>] [--goal <text>] [--budget <usd>] [--container]

  --factory  agentrun checkout with a built packages/factory/dist/bin.mjs
  --out      new output directory for public evidence only
  --id       workflow id
  --example  example project, relative to the checkout or absolute (default: examples/factory/notes-ts)
  --check    profile check to repeat on the export (default: the first acceptance criterion's check)
  --goal     goal text (default: "Store a note and read it after restart")
  --budget   provider budget in USD written to the profile limits (default: 4)
EOF
  exit 2
}

# CI runs the agent in a container. Local mode keeps the developer's user.
for argument in "$@"; do
  if [ "$argument" = --container ]; then
    export PATH=/usr/sbin:/usr/bin:/sbin:/bin
    args=()
    for value in "$@"; do
      [ "$value" = --container ] || args+=("$value")
    done
    exec /usr/bin/python3 -I "${BASH_SOURCE[0]%/*}/separated-journey.py" "${args[@]}"
  fi
done
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  echo 'CI requires --container' >&2
  exit 2
fi

factory=""
out=""
id=""
example="examples/factory/notes-ts"
check=""
goal="Store a note and read it after restart"
budget="4"
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --factory) factory=$2 ;;
    --out) out=$2 ;;
    --id) id=$2 ;;
    --example) example=$2 ;;
    --check) check=$2 ;;
    --goal) goal=$2 ;;
    --budget) budget=$2 ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$factory" ] && [ -n "$out" ] && [ -n "$id" ] || usage

factory=$(cd "$factory" && pwd)
case "$example" in
  /*) ;;
  *) example=$factory/$example ;;
esac
bin=$factory/packages/factory/dist/bin.mjs
[ -f "$bin" ] || { echo "missing $bin: run pnpm build first" >&2; exit 2; }
[ -f "$example/factory.json" ] || { echo "missing $example/factory.json" >&2; exit 2; }
[ ! -e "$out" ] || { echo "$out already exists" >&2; exit 2; }

umask 077
mkdir -p "$out"
out=$(cd "$out" && pwd)
# Private command output stays under --out only until the EXIT cleanup.
work=$out/.private
mkdir "$work"
mkdir "$work/control" "$work/tools"
cp "$factory/packages/factory/scripts/journey-evidence.py" "$work/control/journey-evidence.py"
helper=$work/control/journey-evidence.py
target=$work/agent/target
verify=$work/verify
records=""
record() { records+="$1=$2"$'\n'; }
# Keep trusted values in the parent shell, outside the agent's writable files.
trusted=$(python3 "$helper" toolchain "$factory")
channels=$(python3 "$helper" file-commands snapshot)
exec 3>&1
exec >"$work/harness.log" 2>&1
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
finish() {
  local code=$?
  trap - EXIT
  local prepared=yes
  python3 "$helper" file-commands check <<< "$channels" || code=1
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$GITHUB_STEP_SUMMARY" ]; then
    : > "$GITHUB_STEP_SUMMARY" || code=1
  fi
  python3 "$helper" summarize "$work" "$out" "$code" "$records" <<< "$trusted" || prepared=no
  # Factory state and command logs can contain provider data. Never upload them.
  rm -rf "$work"
  if [ "$prepared" != yes ] || ! python3 "$factory/packages/factory/scripts/journey-evidence.py" scan "$out" >/dev/null 2>&1; then
    code=1
  fi
  if [ "$code" -eq 0 ]; then echo 'RESULT PASS' >&3; else echo 'RESULT FAIL' >&3; fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# These overrides also protect factory/executor Git calls from hooks and monitors.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null
export GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false
python3 "$helper" git-shim "$work/tools"
export PATH="$work/tools:$PATH"
safe_git() {
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"
}
# Keep executor worktrees and provider caches within the agent directory.
export HOME="$work/agent/home" TMPDIR="$work/agent/tmp"
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache"
export CLAUDE_CONFIG_DIR="$HOME/.claude" PI_CODING_AGENT_DIR="$HOME/.pi"
mkdir -p "$HOME" "$TMPDIR" "$verify/artifacts" "$verify/base-artifacts" "$verify/src" "$verify/base"

cp -R "$example" "$target"
python3 - "$target/factory.json" "$budget" <<'PY'
import json, sys
path, budget = sys.argv[1], float(sys.argv[2])
profile = json.load(open(path))
profile["limits"]["providerBudgetUsd"] = budget
profile["limits"]["durationMs"] = 2700000
with open(path, "w") as file:
    json.dump(profile, file, indent=2)
    file.write("\n")
PY

# The check to repeat: its argv and cwd come from the profile, never from this script.
check_spec=$(python3 - "$target/factory.json" "$check" <<'PY'
import json, sys
profile = json.load(open(sys.argv[1]))
wanted = sys.argv[2] or profile["acceptance"][0]["check"]
match = [check for check in profile["checks"] if check["id"] == wanted]
if not match:
    sys.exit(f"profile has no check {wanted!r}")
print(json.dumps({"id": wanted, "argv": match[0]["argv"], "cwd": match[0]["cwd"]}))
PY
)
check_id=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["id"])' "$check_spec")
check_cwd=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["cwd"])' "$check_spec")
check_argv=()
while IFS= read -r -d '' arg; do check_argv+=("$arg"); done < <(
  python3 -c 'import json, sys; sys.stdout.write("".join(a + "\0" for a in json.loads(sys.argv[1])["argv"]))' "$check_spec"
)

safe_git -C "$target" init -q -b main
safe_git -C "$target" add -A
safe_git -C "$target" -c user.name=factory -c user.email=factory@localhost commit -qm "chore: starter"
base=$(safe_git -C "$target" rev-parse HEAD)

status=0
python3 "$helper" capture "$work/start.json" "$target" \
  node "$bin" start --profile factory.json --goal "$goal" --id "$id" --json || status=$?
record start "$status"

read -r stage candidate request evidence version approvable < <(python3 - "$work/start.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {"stage": "unreadable"}
r = d.get("request") or {}
approvable = "yes" if "approve" in (r.get("allowedActions") or []) else "no"
print(d.get("stage", "-"), (d.get("candidate") or {}).get("commit", "-"), r.get("id", "-"), r.get("evidenceDigest", "-"), r.get("expectedVersion", "-"), approvable)
PY
)
if [ "$stage" != human ] || [ "$approvable" != yes ] || [ "$status" -ne 0 ]; then
  exit 1
fi

status=0
python3 "$helper" capture "$work/decide.json" "$target" \
  node "$bin" decide "$id" --request "$request" --candidate "$candidate" --evidence "$evidence" \
  --expected-version "$version" --action approve --json || status=$?
record decide "$status"
status=0
python3 "$helper" capture "$work/export.json" "$target" node "$bin" export "$id" --json || status=$?
record export "$status"
exported=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["export"]["directory"])' "$work/export.json" 2>/dev/null || echo "")

# Read only copied objects. Candidate config, hooks and worktree settings are excluded.
safe_git init -q --bare "$work/evidence.git"
cp -R "$target/.git/objects/." "$work/evidence.git/objects/"
if [ -n "$exported" ] && safe_git --git-dir="$work/evidence.git" diff --no-ext-diff --no-textconv --binary "$base" "$candidate" | cmp -s - "$exported/change.patch"; then
  record patch equal
else
  record patch DIFFERENT
fi

# Repeat the check on the exported source and on the starter. The starter run is the negative control.
run_check() {
  local source=$1 artifacts=$2 result=$3 attempt=$4 commit=$5 log=$6 code=0
  python3 "$helper" capture "$log" "$source/$check_cwd" \
    env -u NODE_OPTIONS -u ANTHROPIC_API_KEY FACTORY_ARTIFACT_DIR="$artifacts" FACTORY_RESULT="$result" \
    FACTORY_ATTEMPT_ID="$attempt" FACTORY_CANDIDATE="$commit" FACTORY_CHECK_ID="$check_id" \
    FACTORY_RUN_ID="$id" FACTORY_WORKSPACE="$source" "${check_argv[@]}" || code=$?
  echo "$code"
}
if [ -n "$exported" ] && tar -xf "$exported/source.tar" -C "$verify/src"; then
  record independent-check "$(run_check "$verify/src" "$verify/artifacts" "$verify/result.json" independent "$candidate" "$verify/check.out")"
else
  record independent-check missing-source
fi
safe_git --git-dir="$work/evidence.git" archive "$base" | tar -x -C "$verify/base"
record negative-control "$(run_check "$verify/base" "$verify/base-artifacts" "$verify/base-result.json" negative "$base" "$verify/base.out")"
if grep -qx 'decide=0' <<< "$records" && grep -qx 'export=0' <<< "$records" && grep -qx 'patch=equal' <<< "$records" \
  && grep -qx 'independent-check=0' <<< "$records" && ! grep -qx 'negative-control=0' <<< "$records"; then
  exit 0
else
  exit 1
fi
