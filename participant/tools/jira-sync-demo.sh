#!/bin/bash
# Demonstrates the Jira synchronization (participant/tools/jira-sync.mjs) for the
# jira-read-assigned-stories quest, against the pretend Jira and the quest's practice data only.
#
#   bash participant/tools/jira-sync-demo.sh <logs folder>   (from the repository's top folder)
#
# Part A, in a new temp folder: every practice set synchronized twice, with a person's note in
# place, showing the second run changes nothing and the note stays byte-identical; then the five
# practice faults, each refused with its own message and nothing written, and a previous
# stories.json this tool didn't write, refused and left exactly as it was.
# Part B, in the real folder (participant/context/jira/assigned): each practice set synchronized
# (twice), then checked by the app's own validator (`quest-app action run-validator`), ending with
# stale-item, whose result is the one kept. Only the three generated files are replaced between
# sets; the notes folder is never touched by this script, and its existing files are fingerprinted
# before and after.
#
# Writes sync-run.txt into <logs folder> only if everything came out as expected. Exit codes:
# 0 all as expected, 1 something unexpected (nothing written), 2 setup error.
set -u -o pipefail
REPO=$(cd -P . && printf '%s/.' "$PWD") || exit 2
REPO=${REPO%/.}
SYNC="$REPO/participant/tools/jira-sync.mjs"
APP="$REPO/.venv/bin/quest-app"
REAL="$REPO/participant/context/jira/assigned"
[ -f "$SYNC" ] && [ -x "$APP" ] && [ -d "$REAL/notes" ] || { echo "Run this from the repository's top folder (with the app installed and the notes folder present)."; exit 2; }
[ $# -eq 1 ] || { echo "Usage: bash participant/tools/jira-sync-demo.sh <logs folder>"; exit 2; }
mkdir -p "$1" || exit 2
LOGS=$(cd -P -- "$1" && printf '%s/.' "$PWD") || exit 2
LOGS=${LOGS%/.}
NAME=sync-run.txt
if [ -L "$LOGS/$NAME" ] || { [ -e "$LOGS/$NAME" ] && [ ! -f "$LOGS/$NAME" ]; }; then
  echo "$NAME in the logs folder is not an ordinary file; stopping."; exit 2
fi

T=$(mktemp -d "${TMPDIR:-/tmp}/jira-sync-demo.XXXXXX") || exit 2
[ -n "$T" ] && [ -d "$T" ] && [ ! -L "$T" ] || { echo "Couldn't make the temp folder."; exit 2; }
T=$(cd -P -- "$T" && printf '%s/.' "$PWD") || exit 2
T=${T%/.}
case "$(basename "$T")" in
  jira-sync-demo.??????) ;;
  *) echo "Unexpected temp folder; stopping."; exit 2 ;;
esac
[ -z "$(ls -A "$T")" ] || { echo "The temp folder isn't new; stopping."; exit 2; }
cleanup() { rm -rf -- "$T"; }
trap 'cleanup; exit 130' INT TERM
FAIL=0
OUT="$T/$NAME"

# notes_print <folder>: SHA-256 of every notes file, one per line (empty when there are none)
notes_print() {
  node -e '
    const fs = require("fs"), c = require("crypto"), d = process.argv[1];
    try {
      for (const f of fs.readdirSync(d).sort()) console.log(c.createHash("sha256").update(fs.readFileSync(`${d}/${f}`)).digest("hex"), f);
    } catch { process.exit(1); }
  ' "$1/notes"
}
# field <stories.json> <js expression over d>: a value from a stories or summary file
field() { node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(eval(process.argv[2]))' "$1" "$2"; }
expect() {  # expect <description> <actual> <wanted>
  if [ "$2" = "$3" ]; then echo "  as expected: $1 = $2"; else echo "  UNEXPECTED: $1 = $2, expected $3"; FAIL=1; fi
}
run_sync() {  # run_sync <folder> <args...>: a synchronization, its output shown without temp paths
  local dir=$1 out code
  shift
  echo "\$ node jira-sync.mjs $* --out $( [ "$dir" = "$REAL" ] && echo participant/context/jira/assigned || echo "${dir#"$T/"}")"
  out=$(cd "$REPO" && node "$SYNC" "$@" --out "$dir" </dev/null 2>&1); code=$?
  printf '%s\n' "${out//"$T/"/}"
  return $code
}
NOTE="# Notes: GTQ-101

A person's note (made-up): asked about the edge case; answer pending.
"

{
  echo "jira-read-assigned-stories: synchronization runs and validator checks"
  echo "Recorded $(date '+%m-%d-%Y %I:%M %p') with Node $(node --version), by participant/tools/jira-sync-demo.sh."
  echo "Source: the pretend Jira (participant/tools/fake-jira.mjs) serving the quest's practice data"
  echo "(validators/fixtures/jira/). No real Jira is contacted. Part A folders are relative to a temp folder."
  echo

  echo "=================== Part A: each practice set, synchronized twice ==================="
  for set in happy-path pagination duplicate-comment stale-item; do
    echo
    echo "== $set =="
    D="$T/$set"
    mkdir -p "$D/notes"
    printf '%s' "$NOTE" > "$D/notes/GTQ-101.md"
    if [ "$set" = stale-item ]; then first="--phase previous"; else first=""; fi
    # shellcheck disable=SC2086
    run_sync "$D" --fixture "$set" $first || { echo "  UNEXPECTED: the first run failed"; FAIL=1; }
    notes_print "$D" > "$T/$set.before"
    run_sync "$D" --fixture "$set" || { echo "  UNEXPECTED: the second run failed"; FAIL=1; }
    notes_print "$D" > "$T/$set.after"
    echo "Checked after the second run:"
    if cmp -s "$T/$set.before" "$T/$set.after"; then echo "  as expected: every notes file is byte-identical across the second run (SHA-256 before and after):"; sed 's/^/    /' "$T/$set.after"; else echo "  UNEXPECTED: a notes file changed"; diff "$T/$set.before" "$T/$set.after"; FAIL=1; fi
    expect "the person's note GTQ-101.md" "$(cat "$D/notes/GTQ-101.md")" "$(printf '%s' "$NOTE")"
    S="$D/sync-summary.json"; J="$D/stories.json"
    expect "list complete (stories received = Jira's total, and Jira said it was the last page)" "$(field "$S" 'd.complete')" true
    if [ "$set" = stale-item ]; then
      expect "removed this run" "$(field "$S" 'd.removed_this_run.join(",")')" GTQ-100
      expect "removed story kept with its last known status" "$(field "$J" 'd.removed.map(r => r.key + " " + r.last_known_status).join(",")')" "GTQ-100 In Progress"
      expect "removed story's notes file kept" "$( [ -f "$D/notes/GTQ-100.md" ] && echo kept || echo missing)" kept
    else
      expect "new and changed stories on the second run" "$(field "$S" 'd.new.length + d.changed.length')" 0
    fi
    case "$set" in
      pagination) expect "pages read" "$(field "$S" 'd.pages_read')" 2; expect "stories" "$(field "$J" 'd.stories.map(s => s.key).join(",")')" "GTQ-101,GTQ-102,GTQ-201,GTQ-202" ;;
      duplicate-comment) expect "GTQ-101's comments, each id once" "$(field "$J" 'd.stories.find(s => s.key === "GTQ-101").comments.map(c => c.id).join(",")')" "9001,9002"; expect "duplicate comments skipped" "$(field "$S" 'd.duplicate_comments_skipped')" 1 ;;
      happy-path) expect "pages read" "$(field "$S" 'd.pages_read')" 1 ;;
    esac
  done

  echo
  echo "=================== Part A: the pretend Jira misbehaving ==================="
  # <fault> <practice set> <the message it must give>
  while read -r fault set msg; do
    echo
    echo "== practice fault: $fault =="
    D="$T/fault-$fault"
    echo "\$ JIRA_PRACTICE_FAULT=$fault node jira-sync.mjs --fixture $set --out fault-$fault"
    out=$(cd "$REPO" && JIRA_PRACTICE_FAULT=$fault node "$SYNC" --fixture "$set" --out "$D" </dev/null 2>&1); code=$?
    printf '%s\n' "${out//"$T/"/}"
    expect "exit code" "$code" 1
    expect "message" "$out" "$msg"
    expect "files written" "$( [ -e "$D" ] && ls -A "$D" | wc -l | tr -d ' ' || echo 0)" 0
  done <<'FAULTS'
empty-page pagination Incomplete: Jira reported 4 stories but page 3 was empty; nothing was written.
wrong-total pagination Incomplete: Jira reported 5 stories, 4 arrived (4 distinct); nothing was written.
repeat-page pagination Incomplete: Jira reported 4 stories but sent more (6 after page 3); nothing was written.
comment-gap duplicate-comment Incomplete: Jira reported 3 comments on GTQ-101 but comment page 1 was empty; nothing was written.
unsafe-key pagination Incomplete: Jira returned "../GTQ-101", which is not a Jira key; nothing was written.
FAULTS

  echo
  echo "== a previous stories.json this tool didn't write (it holds just null) =="
  D="$T/not-ours"
  mkdir -p "$D"
  printf 'null\n' > "$D/stories.json"
  run_sync "$D" --fixture happy-path; code=$?
  expect "exit code" "$code" 2
  expect "the previous stories.json, left as it was" "$(cat "$D/stories.json")" null
  expect "files in the folder (only that stories.json)" "$(ls -A "$D" | tr '\n' ' ')" "stories.json "

  echo
  echo "=================== Part B: the real folder, checked by the app's own validator ==================="
  notes_print "$REAL" > "$T/real-notes-before"
  echo "Notes files in participant/context/jira/assigned/notes before Part B (SHA-256):"
  sed 's/^/  /' "$T/real-notes-before"
  for set in happy-path pagination duplicate-comment stale-item; do
    echo
    echo "== $set =="
    # A fresh start for each set: only the three generated files are removed, never the notes.
    node -e 'const fs = require("fs"); for (const f of ["stories.json", "index.md", "sync-summary.json"]) { try { fs.unlinkSync(`${process.argv[1]}/${f}`); } catch (e) { if (e.code !== "ENOENT") throw e; } }' "$REAL" || FAIL=1
    if [ "$set" = stale-item ]; then first="--phase previous"; else first=""; fi
    # shellcheck disable=SC2086
    run_sync "$REAL" --fixture "$set" $first || { echo "  UNEXPECTED: the first run failed"; FAIL=1; }
    run_sync "$REAL" --fixture "$set" || { echo "  UNEXPECTED: the second run failed"; FAIL=1; }
    echo "\$ quest-app action run-validator --quest jira-read-assigned-stories --validator validate-jira-read-assigned --param fixture_set=$set"
    res=$(cd "$REPO" && "$APP" action run-validator --quest jira-read-assigned-stories --validator validate-jira-read-assigned --param "fixture_set=$set" --json 2>&1)
    path=$(printf '%s' "$res" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s);console.log(d.result_path||"")}catch{console.log("")}})')
    if [ -z "$path" ] || [ ! -f "$REPO/$path" ]; then echo "  UNEXPECTED: the validator gave no result"; FAIL=1; continue; fi
    echo "  result: $path"
    node -e '
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(`  outcome: ${d.outcome} (fixture_set ${d.environment.parameter_fixture_set}, network ${d.environment.network})`);
      for (const c of d.checks) console.log(`    ${c.outcome.toUpperCase().padEnd(5)} ${c.id}: ${c.summary} (${c.evidence})`);
    ' "$REPO/$path"
    expect "validator outcome" "$(field "$REPO/$path" 'd.outcome')" pass
    expect "checks that didn't pass" "$(field "$REPO/$path" 'd.checks.filter(c => c.outcome !== "pass").length')" 0
  done
  notes_print "$REAL" > "$T/real-notes-after"
  echo
  echo "Notes files that existed before Part B, compared after it:"
  node -e '
    const fs = require("fs"), [a, b] = process.argv.slice(1);
    const after = new Map(fs.readFileSync(b, "utf8").trim().split("\n").filter(Boolean).map((l) => [l.split(" ")[1], l.split(" ")[0]]));
    let bad = 0;
    for (const l of fs.readFileSync(a, "utf8").trim().split("\n").filter(Boolean)) {
      const [h, f] = l.split(" ");
      const same = after.get(f) === h;
      if (!same) bad++;
      console.log(`  ${same ? "identical" : "CHANGED"}  ${f}`);
    }
    process.exit(bad ? 1 : 0);
  ' "$T/real-notes-before" "$T/real-notes-after" || { echo "  UNEXPECTED: a notes file changed"; FAIL=1; }
  echo
  echo "The repository keeps the stale-item result: stories.json lists GTQ-101 and GTQ-102, and GTQ-100 under \"removed\"."
  expect "kept stories" "$(field "$REAL/stories.json" 'd.stories.map(s => s.key).join(",")')" "GTQ-101,GTQ-102"
  expect "kept removed" "$(field "$REAL/stories.json" 'd.removed.map(r => r.key).join(",")')" "GTQ-100"
} > "$OUT" 2>&1

if grep -qF -- "$T" "$OUT" || grep -qF -- "$REPO" "$OUT" || { [ -n "${HOME:-}" ] && grep -qF -- "$HOME" "$OUT"; }; then
  echo "The log contains a temp, repository or home folder address; nothing is written or shown."
  cleanup
  exit 1
fi
if [ "$FAIL" != 0 ]; then
  echo "Something unexpected happened; nothing was written. The log (temp folder names hidden):"
  while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "${line//"$T"/<temp>}"; done < "$OUT"
  cleanup
  exit 1
fi
node -e '
  const fs = require("fs"), [src, dir, name] = process.argv.slice(1);
  const tmp = `${dir}/.${name}.${process.pid}.new`;
  fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
  try { fs.renameSync(tmp, `${dir}/${name}`); } catch (e) { fs.unlinkSync(tmp); throw e; }
' "$OUT" "$LOGS" "$NAME" || { echo "Couldn't put $NAME in place."; cleanup; exit 2; }
cleanup
echo "Written: $NAME"
