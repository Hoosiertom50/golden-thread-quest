#!/bin/bash
# Demonstrates the write-guard (participant/tools/zone-guard.mjs) for the base-camp-ownership-zones
# quest, in a throwaway sandbox: a small copy of the repository's zone layout, with the real
# zone-rules.md copied in, links that lead out of it, and a folder outside it. Nothing is aimed at
# the real repository. It writes three logs into <logs folder> (replacing them if present):
# refused-write.txt, allowed-write.txt and zone-report.txt.
#
#   bash participant/tools/zone-guard-demo.sh <logs folder>   (from the repository's top folder)
set -u
REPO=$(pwd -P)
GUARD="$REPO/participant/tools/zone-guard.mjs"
FP="$REPO/participant/tools/workspace-fingerprint.mjs"
RULES="$REPO/participant/context/zone-rules.md"
[ -f "$GUARD" ] && [ -f "$RULES" ] || { echo "Run this from the repository's top folder."; exit 2; }
[ $# -eq 1 ] || { echo "Usage: bash participant/tools/zone-guard-demo.sh <logs folder>"; exit 2; }
mkdir -p "$1" || exit 2
LOGS=$(cd "$1" && pwd -P) || exit 2

# The sandbox: a new temp folder, checked to be one before anything is ever deleted from it.
T=$(mktemp -d) || exit 2
T=$(cd "$T" && pwd -P)
case "$T" in
  /private/var/folders/*/T/tmp.*) ;;
  *) echo "Unexpected temp folder; stopping."; exit 2 ;;
esac
FPDIR=$(mktemp -d) || exit 2
FPDIR=$(cd "$FPDIR" && pwd -P)
case "$FPDIR" in
  /private/var/folders/*/T/tmp.*) ;;
  *) echo "Unexpected temp folder; stopping."; exit 2 ;;
esac

S="$T/sandbox"
mkdir -p "$S/repo/content" "$S/repo/tools" "$S/repo/generated" "$S/repo/local-data" \
  "$S/repo/participant/context" "$S/repo/participant/notes" "$S/repo/scratch" "$S/outside"
cp "$RULES" "$S/repo/participant/context/zone-rules.md"
printf 'Program readme (sandbox copy)\n' > "$S/repo/README.md"
printf 'A curriculum file (sandbox copy)\n' > "$S/repo/content/quest.md"
# The links an escape would use:
ln -s ../../outside "$S/repo/participant/outside-link"          # a folder link leading out
ln -s ../content "$S/repo/participant/content-link"             # a folder link into Program
ln -s ../../../outside/escape.md "$S/repo/participant/notes/escape.md"  # a link where the file would go

TEXT="Notes: draft seating plan, table 4 has two open seats."
run() {  # run <guard arguments...>: shows the command, its output and its exit code
  local shown="" a
  for a in "$@"; do
    case "$a" in *" "*) shown="$shown \"$a\"" ;; *) shown="$shown $a" ;; esac
  done
  echo "\$ node zone-guard.mjs$shown"
  (cd "$S/repo" && node "$GUARD" "$@")
  echo "exit code: $?"
  echo
}
listing() {  # every entry in the sandbox, with where each link points
  (cd "$S" && find . -print | LC_ALL=C sort | while IFS= read -r p; do
    if [ -L "$p" ]; then echo "$p -> $(readlink "$p")"; else echo "$p"; fi
  done)
}
fingerprint() {  # fingerprint <name>: the whole sandbox (repo and outside folder)
  (cd "$S" && node "$FP" "$FPDIR/$1.txt") | sed 's/^/  /'
}
header() {
  echo "base-camp-ownership-zones: $1"
  echo "Recorded $(date '+%m-%d-%Y %I:%M %p') with Node $(node --version), by participant/tools/zone-guard-demo.sh."
  echo "Sandbox: a new temp folder holding repo/ (the zone layout, with the real zone-rules.md copied in)"
  echo "and outside/ (a folder outside that repository). Paths below are relative to the sandbox."
  echo "The rules copy is identical to participant/context/zone-rules.md:"
  echo "  repository: $(shasum -a 256 "$RULES" | cut -d' ' -f1)"
  echo "  sandbox:    $(shasum -a 256 "$S/repo/participant/context/zone-rules.md" | cut -d' ' -f1)"
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
  run write content/notes.md "$TEXT"
  echo "== 2. Using .. to leave the allowed folder (participant/) for a program folder =="
  run write participant/../content/notes.md "$TEXT"
  echo "== 3. Using .. to leave the repository altogether =="
  run write participant/../../outside/notes.md "$TEXT"
  echo "== 4. Through a symbolic link that leads outside the repository =="
  echo "(participant/outside-link -> ../../outside; the text looks like a participant path)"
  run write participant/outside-link/notes.md "$TEXT"
  echo "== 5. Through a symbolic link into a program folder =="
  echo "(participant/content-link -> ../content)"
  run write participant/content-link/notes.md "$TEXT"
  echo "== 6. A link standing where the new file would go =="
  echo "(participant/notes/escape.md -> ../../../outside/escape.md, which doesn't exist yet)"
  run write participant/notes/escape.md "$TEXT"
  echo "== 7. Into the Generated zone =="
  run write generated/notes.md "$TEXT"
  echo "== 8. Into a folder that belongs to no zone (stretch goal) =="
  run write scratch/notes.md "$TEXT"
  echo "== 9. A new file at the top of the repository (Program, entry *) =="
  run write notes.md "$TEXT"
  echo "== The sandbox after =="
  listing
  echo
  echo "Fingerprint after:"
  fingerprint after
  echo
  if cmp -s "$FPDIR/before.txt" "$FPDIR/after.txt"; then
    echo "RESULT: the before and after lists are identical. No file, empty file or partial file was"
    echo "created anywhere in the sandbox, inside or outside the repository, and nothing changed."
  else
    echo "RESULT: THE SANDBOX CHANGED:"
    diff "$FPDIR/before.txt" "$FPDIR/after.txt"
  fi
  echo "Files named notes.md or escape.md anywhere in the sandbox:"
  (cd "$S" && find . \( -name notes.md -o -name escape.md \) ! -type l -print | LC_ALL=C sort | sed 's/^/  /')
  echo "  (end of list)"
} > "$LOGS/refused-write.txt" 2>&1

# ---------------------------------------------------------------- allowed-write.txt
{
  header "allowed writes"
  echo "The same operation as refused-write.txt, aimed at participant-owned folders."
  echo
  cp "$FPDIR/after.txt" "$FPDIR/start.txt"
  (cd "$S" && find . -print | LC_ALL=C sort) > "$FPDIR/list-before.txt"
  echo "== 1. Into participant/ (the Participant zone) =="
  run write participant/notes.md "$TEXT"
  echo "== 2. Into participant/notes/ (a folder inside it) =="
  run write participant/notes/notes.md "$TEXT"
  echo "== 3. Raw data into local-data/ (Private data: Agent may write yes) =="
  run write local-data/notes.md "$TEXT"
  echo "== 4. The same write again: an existing file is never overwritten =="
  run write participant/notes.md "Different text"
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
  (cd "$S" && node "$FP" "$FPDIR/end.txt") > /dev/null
  grep -v -E '"(repo/participant/notes\.md|repo/participant/notes/notes\.md|repo/local-data/notes\.md)"$' "$FPDIR/end.txt" \
    | grep -v -E '^dir .* "(repo/participant|repo/participant/notes|repo/local-data)"$' > "$FPDIR/end-rest.txt"
  grep -v -E '^dir .* "(repo/participant|repo/participant/notes|repo/local-data)"$' "$FPDIR/start.txt" > "$FPDIR/start-rest.txt"
  if cmp -s "$FPDIR/start-rest.txt" "$FPDIR/end-rest.txt"; then echo "  identical"; else diff "$FPDIR/start-rest.txt" "$FPDIR/end-rest.txt"; fi
} > "$LOGS/allowed-write.txt" 2>&1

# ---------------------------------------------------------------- zone-report.txt (stretch)
{
  header "zone report and a broken rules table (stretch goals)"
  echo "== zone <path>: which zone, and may an agent write there (writes nothing) =="
  for p in content/quest.md participant/notes.md local-data/raw-response.json generated/index.html \
      participant/tests/playwright/test-results/a.txt README.md scratch/notes.md \
      participant/outside-link/notes.md participant/content-link/notes.md; do
    run zone "$p"
  done
  echo "== A broken rules table refuses every write =="
  echo "(the sandbox's zone-rules.md copy has its Participant row's \"Agent may write\" changed to \"maybe\")"
  sed -i '' 's/^| Participant | `participant\/` | \(.*\) | tracked | yes |$/| Participant | `participant\/` | \1 | tracked | maybe |/' \
    "$S/repo/participant/context/zone-rules.md"
  run write participant/notes2.md "$TEXT"
  echo "== A missing rules table refuses every write =="
  rm "$S/repo/participant/context/zone-rules.md"
  run write participant/notes2.md "$TEXT"
  echo "Files named notes2.md anywhere in the sandbox:"
  (cd "$S" && find . -name notes2.md -print | sed 's/^/  /')
  echo "  (end of list)"
} > "$LOGS/zone-report.txt" 2>&1

# Clean up: only the two validated temp folders.
rm -rf -- "$T" "$FPDIR"
echo "Logs written: refused-write.txt, allowed-write.txt, zone-report.txt"
