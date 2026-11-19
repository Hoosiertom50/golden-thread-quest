#!/bin/bash
# Demonstrates the write-guard (participant/tools/zone-guard.mjs) for the base-camp-ownership-zones
# quest, in a throwaway sandbox: a small copy of the repository's zone layout, with the real
# zone-rules.md copied in, links that lead out of it, and a folder outside it. Nothing is aimed at
# the real repository.
#
#   bash participant/tools/zone-guard-demo.sh <logs folder>   (from the repository's top folder)
#
# It writes three logs into <logs folder>: refused-write.txt, allowed-write.txt, zone-report.txt.
# They are built inside the sandbox first and moved into place only if every step worked (each
# guard result as expected, every fingerprint taken). An existing log is replaced only if it is an
# ordinary file: a link standing there is refused, never followed. Exit codes: 0 all as expected,
# 1 something unexpected (no logs moved), 2 setup error. Needs bash, Node and the usual Unix tools
# (macOS or Linux); the sandbox goes in $TMPDIR (or /tmp).
set -u -o pipefail
REPO=$(pwd -P)
GUARD="$REPO/participant/tools/zone-guard.mjs"
FP="$REPO/participant/tools/workspace-fingerprint.mjs"
RULES="$REPO/participant/context/zone-rules.md"
[ -f "$GUARD" ] && [ -f "$FP" ] && [ -f "$RULES" ] || { echo "Run this from the repository's top folder."; exit 2; }
[ $# -eq 1 ] || { echo "Usage: bash participant/tools/zone-guard-demo.sh <logs folder>"; exit 2; }
mkdir -p "$1" || exit 2
LOGS=$(cd "$1" && pwd -P) || exit 2
NAMES="refused-write.txt allowed-write.txt zone-report.txt"
for n in $NAMES; do
  if [ -L "$LOGS/$n" ] || { [ -e "$LOGS/$n" ] && [ ! -f "$LOGS/$n" ]; }; then
    echo "$n in the logs folder is not an ordinary file; stopping."; exit 2
  fi
done

# The sandbox: one new temp folder, checked before anything is ever deleted from it.
T=$(mktemp -d "${TMPDIR:-/tmp}/zone-guard-demo.XXXXXX") || exit 2
[ -n "$T" ] && [ -d "$T" ] && [ ! -L "$T" ] || { echo "Couldn't make the sandbox folder."; exit 2; }
T=$(cd "$T" && pwd -P) || exit 2
case "$(basename "$T")" in
  zone-guard-demo.??????) ;;
  *) echo "Unexpected sandbox folder; stopping."; exit 2 ;;
esac
[ -z "$(ls -A "$T")" ] || { echo "The sandbox folder isn't new; stopping."; exit 2; }
cleanup() { rm -rf -- "$T"; }

S="$T/sandbox"   # what is fingerprinted
FPDIR="$T/fp"    # fingerprint lists, outside the fingerprinted folder
OUT="$T/out"     # the logs, until every step has worked
FAIL=0
mkdir -p "$FPDIR" "$OUT" "$S/repo/content" "$S/repo/tools" "$S/repo/generated" "$S/repo/local-data" \
  "$S/repo/participant/context" "$S/repo/participant/notes" "$S/repo/scratch" "$S/outside" || { cleanup; exit 2; }
cp "$RULES" "$S/repo/participant/context/zone-rules.md" || { cleanup; exit 2; }
printf 'Program readme (sandbox copy)\n' > "$S/repo/README.md"
printf 'A curriculum file (sandbox copy)\n' > "$S/repo/content/quest.md"
# The links an escape would use:
ln -s ../../outside "$S/repo/participant/outside-link"          # a folder link leading out
ln -s ../content "$S/repo/participant/content-link"             # a folder link into Program
ln -s ../../../outside/escape.md "$S/repo/participant/notes/escape.md"  # a link where the file would go

TEXT="Notes: draft seating plan, table 4 has two open seats."
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
run() {  # run <expected exit code> <guard arguments...>: shows the command, its output and exit code
  local want=$1 shown="" a code
  shift
  for a in "$@"; do
    case "$a" in *" "*) shown="$shown \"$a\"" ;; *) shown="$shown $a" ;; esac
  done
  echo "\$ node zone-guard.mjs$shown"
  (cd "$S/repo" && node "$GUARD" "$@")
  code=$?
  echo "exit code: $code"
  if [ "$code" != "$want" ]; then echo "UNEXPECTED: exit code $want was expected"; FAIL=1; fi
  echo
}
listing() {  # every entry in the sandbox, with where each link points
  (cd "$S" && find . -print | LC_ALL=C sort | while IFS= read -r p; do
    if [ -L "$p" ]; then echo "$p -> $(readlink "$p")"; else echo "$p"; fi
  done)
}
fingerprint() {  # fingerprint <name>: the whole sandbox (repo and outside folder)
  local out
  if out=$(cd "$S" && node "$FP" "$FPDIR/$1.txt"); then echo "  $out"; else echo "  FINGERPRINT FAILED"; FAIL=1; fi
}
header() {
  echo "base-camp-ownership-zones: $1"
  echo "Recorded $(date '+%m-%d-%Y %I:%M %p') with Node $(node --version), by participant/tools/zone-guard-demo.sh."
  echo "Sandbox: a new temp folder holding repo/ (the zone layout, with the real zone-rules.md copied in)"
  echo "and outside/ (a folder outside that repository). Paths below are relative to the sandbox."
  echo "The rules copy is identical to participant/context/zone-rules.md:"
  echo "  repository: $(sha "$RULES")"
  echo "  sandbox:    $(sha "$S/repo/participant/context/zone-rules.md")"
  echo
}

# ---------------------------------------------------------------- refused-write.txt
{
  header "refused writes"
  echo "== The sandbox before =="
  listing
  echo
  echo "Fingerprint before (every entry: kind, mode, owner, size, contents, link target):"
  fingerprint before
  echo
  echo "== 1. Into a program-owned zone =="
  run 1 write content/notes.md "$TEXT"
  echo "== 2. Using .. to leave the allowed folder (participant/) for a program folder =="
  run 1 write participant/../content/notes.md "$TEXT"
  echo "== 3. Using .. to leave the repository altogether =="
  run 1 write participant/../../outside/notes.md "$TEXT"
  echo "== 4. Through a symbolic link that leads outside the repository =="
  echo "(participant/outside-link -> ../../outside; the text looks like a participant path)"
  run 1 write participant/outside-link/notes.md "$TEXT"
  echo "== 5. Through a symbolic link into a program folder =="
  echo "(participant/content-link -> ../content)"
  run 1 write participant/content-link/notes.md "$TEXT"
  echo "== 6. A link standing where the new file would go =="
  echo "(participant/notes/escape.md -> ../../../outside/escape.md, which doesn't exist yet)"
  run 1 write participant/notes/escape.md "$TEXT"
  echo "== 7. Into the Generated zone =="
  run 1 write generated/notes.md "$TEXT"
  echo "== 8. Into a folder that belongs to no zone (stretch goal) =="
  run 1 write scratch/notes.md "$TEXT"
  echo "== 9. A new file at the top of the repository (Program, entry *) =="
  run 1 write notes.md "$TEXT"
  echo "== The sandbox after =="
  listing
  echo
  echo "Fingerprint after:"
  fingerprint after
  echo
  if [ -s "$FPDIR/before.txt" ] && cmp -s "$FPDIR/before.txt" "$FPDIR/after.txt"; then
    echo "RESULT: the before and after lists are identical. No file, empty file or partial file was"
    echo "created anywhere in the sandbox, inside or outside the repository, and nothing changed."
  else
    echo "RESULT: THE SANDBOX CHANGED (or a fingerprint is missing):"
    diff "$FPDIR/before.txt" "$FPDIR/after.txt"
    FAIL=1
  fi
  echo "Files named notes.md or escape.md anywhere in the sandbox:"
  (cd "$S" && find . \( -name notes.md -o -name escape.md \) ! -type l -print | LC_ALL=C sort | sed 's/^/  /')
  echo "  (end of list)"
} > "$OUT/refused-write.txt" 2>&1

# ---------------------------------------------------------------- allowed-write.txt
{
  header "allowed writes"
  echo "The same operation as refused-write.txt, aimed at participant-owned folders."
  echo
  (cd "$S" && find . -print | LC_ALL=C sort) > "$FPDIR/list-before.txt"
  echo "== 1. Into participant/ (the Participant zone) =="
  run 0 write participant/notes.md "$TEXT"
  echo "== 2. Into participant/notes/ (a folder inside it) =="
  run 0 write participant/notes/notes.md "$TEXT"
  echo "== 3. Raw data into local-data/ (Private data: Agent may write yes) =="
  run 0 write local-data/notes.md "$TEXT"
  echo "== 4. The same write again: an existing file is never overwritten =="
  run 1 write participant/notes.md "Different text"
  echo "== What was created (every entry now in the sandbox that wasn't before) =="
  (cd "$S" && find . -print | LC_ALL=C sort) > "$FPDIR/list-after.txt"
  comm -13 "$FPDIR/list-before.txt" "$FPDIR/list-after.txt" | sed 's/^/  /'
  echo "  (end of list)"
  echo
  echo "== The contents of participant/notes.md (unchanged by write 4) =="
  cat "$S/repo/participant/notes.md"
  echo
  echo
  echo "== Nothing else changed =="
  echo "Every entry in the before list is still there, unchanged (only the three new files and their"
  echo "folders' entries differ):"
  fingerprint end > /dev/null
  NEW='"(repo/participant/notes\.md|repo/participant/notes/notes\.md|repo/local-data/notes\.md)"$'
  DIRS='^dir .* "(repo/participant|repo/participant/notes|repo/local-data)"$'
  grep -v -E "$NEW" "$FPDIR/end.txt" | grep -v -E "$DIRS" > "$FPDIR/end-rest.txt"
  grep -v -E "$DIRS" "$FPDIR/after.txt" > "$FPDIR/start-rest.txt"
  if [ -s "$FPDIR/start-rest.txt" ] && cmp -s "$FPDIR/start-rest.txt" "$FPDIR/end-rest.txt"; then
    echo "  identical"
  else
    diff "$FPDIR/start-rest.txt" "$FPDIR/end-rest.txt"
    FAIL=1
  fi
} > "$OUT/allowed-write.txt" 2>&1

# ---------------------------------------------------------------- zone-report.txt (stretch)
{
  header "zone report and a broken rules table (stretch goals)"
  echo "== zone <path>: which zone, and may an agent write there (writes nothing) =="
  for p in content/quest.md participant/notes.md local-data/raw-response.json generated/index.html \
      participant/tests/playwright/test-results/a.txt README.md; do
    run 0 zone "$p"
  done
  for p in scratch/notes.md participant/outside-link/notes.md; do
    run 1 zone "$p"
  done
  run 0 zone participant/content-link/notes.md
  echo "== A broken rules table refuses every write =="
  echo "(the sandbox's zone-rules.md copy has its Participant row's \"Agent may write\" changed to \"maybe\")"
  Z="$S/repo/participant/context/zone-rules.md"
  sed 's/^\(| Participant | .* | tracked | \)yes |$/\1maybe |/' "$Z" > "$FPDIR/broken.md" && cat "$FPDIR/broken.md" > "$Z"
  grep -q '| tracked | maybe |$' "$Z" || { echo "UNEXPECTED: the table wasn't changed"; FAIL=1; }
  run 1 write participant/notes2.md "$TEXT"
  echo "== A missing rules table refuses every write =="
  rm -- "$Z"
  run 1 write participant/notes2.md "$TEXT"
  echo "Files named notes2.md anywhere in the sandbox:"
  (cd "$S" && find . -name notes2.md -print | sed 's/^/  /')
  echo "  (end of list)"
} > "$OUT/zone-report.txt" 2>&1

if [ "$FAIL" != 0 ]; then
  echo "Something unexpected happened; no logs were moved. The logs:"
  cat "$OUT"/*.txt
  cleanup
  exit 1
fi
for n in $NAMES; do
  if [ -L "$LOGS/$n" ] || { [ -e "$LOGS/$n" ] && [ ! -f "$LOGS/$n" ]; }; then
    echo "$n in the logs folder is not an ordinary file; stopping."; cleanup; exit 2
  fi
  mv -f -- "$OUT/$n" "$LOGS/$n" || { cleanup; exit 2; }
done
cleanup
echo "Logs written: $NAMES"
