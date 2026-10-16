#!/usr/bin/env bash
# Runs one factory journey against a fresh copy of an example and checks the exported delivery independently.
# The profile's providers make real, paid calls unless NODE_OPTIONS injects a fixture provider.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: real-journey.sh --factory <checkout> --out <new-dir> --id <workflow-id>
                       [--example <dir>] [--check <check-id>] [--goal <text>] [--budget <usd>]

  --factory  agentrun checkout with a built packages/factory/dist/bin.mjs
  --out      new output directory for the target repository and evidence
  --id       workflow id
  --example  example project, relative to the checkout or absolute (default: examples/factory/notes-ts)
  --check    profile check to repeat on the export (default: the first acceptance criterion's check)
  --goal     goal text (default: "Store a note and read it after restart")
  --budget   provider budget in USD written to the profile limits (default: 4)
EOF
  exit 2
}

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

mkdir -p "$out"
out=$(cd "$out" && pwd)
target=$out/target
verify=$out/verify
exits=$out/exits.txt
mkdir -p "$verify/artifacts" "$verify/base-artifacts" "$verify/src" "$verify/base"

{
  echo "node $(node -v)"
  python3 --version
  echo "factory $(git -C "$factory" rev-parse HEAD)"
} | tee "$out/toolchain.txt"
git -C "$factory" rev-parse HEAD > "$out/factory-head.txt"
git -C "$factory" status --short > "$out/factory-dirty.txt"

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
echo "check $check_id: ${check_argv[*]} (cwd $check_cwd)" | tee -a "$out/toolchain.txt"

git -C "$target" init -q -b main
git -C "$target" add -A
git -C "$target" -c user.name=factory -c user.email=factory@localhost commit -qm "chore: starter"
base=$(git -C "$target" rev-parse HEAD)

status=0
(cd "$target" && node "$bin" start --profile factory.json --goal "$goal" --id "$id" --json) \
  > "$out/start.json" 2> "$out/start.stderr" || status=$?
echo "start=$status" > "$exits"

read -r stage candidate request evidence version approvable < <(python3 - "$out/start.json" <<'PY'
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
echo "stage=$stage candidate=$candidate approvable=$approvable" >> "$exits"
if [ "$stage" != human ] || [ "$approvable" != yes ] || ! grep -qx 'start=0' "$exits"; then
  cat "$exits"
  echo "RESULT FAIL at $stage"
  exit 1
fi

status=0
(cd "$target" && node "$bin" decide "$id" --request "$request" --candidate "$candidate" --evidence "$evidence" \
  --expected-version "$version" --action approve --json) > "$out/decide.json" 2> "$out/decide.stderr" || status=$?
echo "decide=$status" >> "$exits"
status=0
(cd "$target" && node "$bin" export "$id" --json) > "$out/export.json" 2> "$out/export.stderr" || status=$?
echo "export=$status" >> "$exits"
exported=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["export"]["directory"])' "$out/export.json" 2>/dev/null || echo "")

git -C "$target" diff --binary "$base" "$candidate" > "$verify/git.patch"
if [ -n "$exported" ] && cmp -s "$verify/git.patch" "$exported/change.patch"; then
  echo "patch=equal" >> "$exits"
else
  echo "patch=DIFFERENT" >> "$exits"
fi

# Repeat the check on the exported source and on the starter. The starter run is the negative control.
run_check() {
  local source=$1 artifacts=$2 result=$3 attempt=$4 commit=$5 log=$6 code=0
  (cd "$source/$check_cwd" && env -u NODE_OPTIONS FACTORY_ARTIFACT_DIR="$artifacts" FACTORY_RESULT="$result" \
    FACTORY_ATTEMPT_ID="$attempt" FACTORY_CANDIDATE="$commit" FACTORY_CHECK_ID="$check_id" \
    FACTORY_RUN_ID="$id" FACTORY_WORKSPACE="$source" "${check_argv[@]}") > "$log" 2>&1 || code=$?
  echo "$code"
}
if [ -n "$exported" ] && tar -xf "$exported/source.tar" -C "$verify/src"; then
  echo "independent-check=$(run_check "$verify/src" "$verify/artifacts" "$verify/result.json" independent "$candidate" "$verify/check.out")" >> "$exits"
else
  echo "independent-check=missing-source" >> "$exits"
fi
git -C "$target" archive "$base" | tar -x -C "$verify/base"
echo "negative-control=$(run_check "$verify/base" "$verify/base-artifacts" "$verify/base-result.json" negative "$base" "$verify/base.out")" >> "$exits"
python3 - "$out/export.json" >> "$exits" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("cost", d.get("costUsd"), "review", json.dumps(d.get("review")))
except Exception:
    print("cost unknown review unknown")
PY

cat "$exits"
if grep -qx 'decide=0' "$exits" && grep -qx 'export=0' "$exits" && grep -qx 'patch=equal' "$exits" \
  && grep -qx 'independent-check=0' "$exits" && ! grep -qx 'negative-control=0' "$exits"; then
  echo "RESULT PASS"
else
  echo "RESULT FAIL"
  exit 1
fi
