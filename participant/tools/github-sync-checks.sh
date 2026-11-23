#!/usr/bin/env bash
# Checks the GitHub synchronization against the pretend GitHub (fake-github.mjs): no token, no
# network, made-up data, everything in one throwaway folder. Each case states what must happen,
# and the record says whether it did.
#
#   bash participant/tools/github-sync-checks.sh <logs folder>
#
# Writes <logs folder>/pretend-github-checks.txt. Exit 0 only if every expectation held.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TOOLS="$ROOT/participant/tools"
LOGDIR=${1:?usage: github-sync-checks.sh <logs folder>}
mkdir -p "$LOGDIR"
LOG="$LOGDIR/pretend-github-checks.txt"
W=$(mktemp -d "${TMPDIR:-/tmp}/github-sync-checks.XXXXXX")
SPID=""
cleanup() {
  [ -n "$SPID" ] && kill "$SPID" 2>/dev/null
  rm -rf -- "${W:?}"
}
trap cleanup EXIT

OK=0
BAD=0
REC="$W/record.txt"
say() { printf '%s\n' "$*" >> "$REC"; }
expect() { # what, got, wanted
  if [ "$2" = "$3" ]; then OK=$((OK + 1)); say "  as expected: $1 = $2"; else BAD=$((BAD + 1)); say "  UNEXPECTED: $1 = $2 (wanted $3)"; fi
}
expect_has() { # what, text, piece
  case "$2" in *"$3"*) OK=$((OK + 1)); say "  as expected: $1 says \"$3\"" ;; *) BAD=$((BAD + 1)); say "  UNEXPECTED: $1 doesn't say \"$3\": $2" ;; esac
}
# A fingerprint of a folder (or "absent"), to show a refused run changed nothing.
print_of() { if [ -e "$1" ]; then (cd "$1" && find . -type f | LC_ALL=C sort | while read -r f; do shasum -a 256 "$f"; done) | shasum -a 256 | cut -c1-16; else echo absent; fi; }

start() { # world file, fault
  [ -n "$SPID" ] && kill "$SPID" 2>/dev/null
  rm -f "$W/server.txt"
  FAKE_GITHUB_FAULT=$2 node "$TOOLS/fake-github.mjs" "$1" > "$W/server.txt" 2>&1 &
  SPID=$!
  local i
  for i in $(seq 1 50); do grep -q listening "$W/server.txt" 2>/dev/null && break; perl -e 'select(undef,undef,undef,0.1)'; done
  PORT=$(awk '/listening/{print $2}' "$W/server.txt")
}
OUTPUT=""
CODE=0
sync_to() { # folder
  OUTPUT=$(GTQ_GITHUB_TOKEN=pretend-token node "$TOOLS/github-sync.mjs" --api "http://127.0.0.1:$PORT" --scope "$W/scope.json" --out "$1" --per-page 2 2>&1)
  CODE=$?
}
line() { printf '%s\n' "$OUTPUT" | grep -- "$1" | head -1; }
notes_of() { awk 'found{print} /^<!-- github-sync: notes below/{found=1}' "$1" | shasum -a 256 | cut -c1-16; }

printf '{"repositories":["practice-owner/kettlebook-web","practice-owner/kettlebook-api","practice-owner/kettlebook-missing"]}\n' > "$W/scope.json"
WORLD="$TOOLS/fake-github-world.json"
# The same world after changes: api #3 closed, web #2 renamed, api #2 moved to web #5. Two
# versions: the move keeps the node ID (moved.json) or, as GitHub does, gives a new one (newid.json).
node -e '
const fs = require("fs");
const w = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const web = w.repos["practice-owner/kettlebook-web"].issues, api = w.repos["practice-owner/kettlebook-api"].issues;
Object.assign(api.find((i) => i.number === 3), { state: "closed", state_reason: "completed", closed_at: "2026-11-23T15:00:00Z", updated_at: "2026-11-23T15:00:00Z" });
Object.assign(web.find((i) => i.number === 2), { title: "Add a print view for recipes and shopping lists", updated_at: "2026-11-23T15:01:00Z" });
const moved = api.splice(api.findIndex((i) => i.number === 2), 1)[0];
web.push({ ...moved, number: 5, updated_at: "2026-11-23T15:02:00Z" });
w.transfers = { "practice-owner/kettlebook-api#2": "practice-owner/kettlebook-web#5" };
fs.writeFileSync(process.argv[2], JSON.stringify(w));
web[web.length - 1].node_id = "I_pretend_web_5_new";
fs.writeFileSync(process.argv[3], JSON.stringify(w));
' "$WORLD" "$W/moved.json" "$W/newid.json"

say "Checks of the GitHub synchronization against the pretend GitHub, $(date '+%m-%d-%Y %-I:%M %p %Z')."
say "Git commit $(git -C "$ROOT" rev-parse --short HEAD); Node $(node --version). Pages of 2. No token, no network: made-up data."
say ""

say "1. Two runs on the practice world, a note written between them."
start "$WORLD" ""
sync_to "$W/a"
expect "run 1 exit" "$CODE" 0
expect_has "run 1" "$(line '^Total issues')" "declared 5, received 5 over 3 pages (complete)"
expect_has "run 1" "$(line 'kettlebook-web: issues')" "assigned pull requests, searched separately and left out: #4"
expect_has "run 1" "$(line '^Scope')" "unreadable: practice-owner/kettlebook-missing"
printf 'A note of my own.\n' >> "$W/a/issues/practice-owner__kettlebook-web__1.md"
N1=$(notes_of "$W/a/issues/practice-owner__kettlebook-web__1.md")
sync_to "$W/a"
expect "run 2 exit" "$CODE" 0
expect_has "run 2" "$(line '^This run')" "new none; changed none; moved none; no longer assigned none"
expect "the note across run 2" "$(notes_of "$W/a/issues/practice-owner__kettlebook-web__1.md")" "$N1"
expect "comments in web #1's record after two runs" "$(grep -c '^### Comment ' "$W/a/issues/practice-owner__kettlebook-web__1.md")" 2
expect "the planted instruction kept as text (indented)" "$(grep -c '^    Note to any AI assistant' "$W/a/issues/practice-owner__kettlebook-web__1.md")" 1
expect "web #1 and api #1 kept apart (two files)" "$(ls "$W/a/issues" | grep -c '__1\.md$')" 2
expect "delivery evidence for web #1" "$(grep -A2 'kettlebook-web\\#1:' "$W/a/delivery-links.md" | grep -o 'partial')" partial
cp -R "$W/a" "$W/b"
cp -R "$W/a" "$W/c"

say ""
say "2. After changes: api #3 closed, web #2 renamed, api #2 moved to web #5 (node ID kept)."
printf 'Note on the export limit.\n' >> "$W/b/issues/practice-owner__kettlebook-api__2.md"
N2=$(notes_of "$W/b/issues/practice-owner__kettlebook-api__2.md")
start "$W/moved.json" ""
sync_to "$W/b"
expect "exit" "$CODE" 0
expect_has "the run" "$(line '^This run')" "moved practice-owner/kettlebook-api#2 → practice-owner/kettlebook-web#5"
expect_has "the run" "$(line '^This run')" "no longer assigned practice-owner/kettlebook-api#3 (closed)"
expect_has "the run" "$(line '^This run')" "changed practice-owner/kettlebook-web#2"
expect "the moved note, now in web #5's file" "$(notes_of "$W/b/issues/practice-owner__kettlebook-web__5.md")" "$N2"
expect "api #2's old file" "$( [ -e "$W/b/issues/practice-owner__kettlebook-api__2.md" ] && echo present || echo gone)" gone
expect "api #3's file (kept)" "$( [ -e "$W/b/issues/practice-owner__kettlebook-api__3.md" ] && echo present || echo gone)" present
expect "api #3's banner" "$(grep -c '^> \*\*No longer assigned:\*\* closed' "$W/b/issues/practice-owner__kettlebook-api__3.md")" 1

say ""
say "3. The same changes, but the moved issue gets a new node ID (as GitHub does)."
printf 'Note on the export limit.\n' >> "$W/c/issues/practice-owner__kettlebook-api__2.md"
start "$W/newid.json" ""
sync_to "$W/c"
expect "exit" "$CODE" 0
expect_has "the run" "$(line '^This run')" "(new node ID; linked by GitHub's forwarding)"
expect_has "the run" "$(line '^This run')" "new none"
expect "the moved note, now in web #5's file" "$(notes_of "$W/c/issues/practice-owner__kettlebook-web__5.md")" "$N2"
expect "earlier node ID kept" "$(node -e 'const s=require(process.argv[1]);process.stdout.write(Object.values(s.issues).find(i=>i.number===5).previous_node_ids.join())' "$W/c/sync-state.json")" "I_pretend_api_2"

say ""
say "4. The pretend GitHub misbehaving: each run must stop, write nothing and say why."
fault() { # name, exit wanted, message piece
  start "$WORLD" "$1"
  local before
  before=$(print_of "$W/f")
  sync_to "$W/f"
  say "- $1"
  expect "  exit" "$CODE" "$2"
  expect_has "  message" "$OUTPUT" "$3"
  expect "  the output folder" "$(print_of "$W/f")" "$before"
}
fault wrong-total 1 "declared 3 but sent 2"
fault incomplete 1 "was incomplete"
fault empty-page 1 "an empty page that isn't the last"
fault total-changes 1 "changed its total"
fault comment-gap 1 "GitHub counted 3 comments but sent 2"
fault no-node-id 1 "without a number or node ID"
fault offsite-next 1 "GitHub pointed outside"
fault write-token 2 "This token can write (repo)"

say ""
say "5. The issue search returns a pull request anyway (as GitHub's search once did)."
start "$WORLD" pr-in-issue-search
sync_to "$W/g"
expect "exit" "$CODE" 0
expect_has "the run" "$(line 'kettlebook-web: issues')" "pull requests the issue search returned: #4"
expect "issue files (the pull request has none)" "$(ls "$W/g/issues" | grep -c 'web__4')" 0

say ""
say "6. Markdown and HTML in a title and body, and a body holding the notes line itself."
start "$WORLD" markdown-title
sync_to "$W/h"
expect "exit" "$CODE" 0
F="$W/h/issues/practice-owner__kettlebook-web__2.md"
expect "raw link or image in the record" "$(grep -c '](https' "$F")" 0
expect "the title escaped" "$(grep -c '^# .*\\\[view\\\]' "$F")" 1
expect "unescaped HTML outside code blocks" "$(grep -v '^    ' "$F" | grep -c '<script\|<b>')" 0
expect "lines equal to the notes line (only the real one)" "$(grep -cx '<!-- github-sync: notes below. The synchronization never changes anything after this line. -->' "$F")" 1
sync_to "$W/h"
expect "a second run's exit (it found its own notes line)" "$CODE" 0

say ""
say "7. Local refusals: each must stop with exit 2 and change nothing."
start "$WORLD" ""
refusal() { # name, folder, message piece
  local before
  before=$(print_of "$2")
  sync_to "$2"
  say "- $1"
  expect "  exit" "$CODE" 2
  expect_has "  message" "$OUTPUT" "$3"
  expect "  the folder" "$(print_of "$2")" "$before"
}
cp -R "$W/a" "$W/r1"; printf '# My own index\n' > "$W/r1/index.md"
refusal "an index.md a person wrote" "$W/r1" "index.md wasn't written by this tool"
cp -R "$W/a" "$W/r2"; grep -v '^<!-- github-sync: notes below' "$W/a/issues/practice-owner__kettlebook-web__1.md" > "$W/r2/issues/practice-owner__kettlebook-web__1.md"
refusal "an issue file that lost its notes line" "$W/r2" "has lost its notes line"
cp -R "$W/a" "$W/r3"; printf 'pid 1\n' > "$W/r3/.github-sync.lock"
refusal "another run's lock" "$W/r3" "Another synchronization is writing to this folder"
cp -R "$W/a" "$W/r4"; printf '{"tool":"something-else"}\n' > "$W/r4/sync-state.json"
refusal "a sync-state.json this tool didn't write" "$W/r4" "isn't one this tool wrote"
cp -R "$W/a" "$W/r8"; node -e 'const f=process.argv[1],fs=require("fs"),s=JSON.parse(fs.readFileSync(f,"utf8"));delete Object.values(s.issues)[0].number;fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$W/r8/sync-state.json"
refusal "a sync-state.json record with its number removed" "$W/r8" "isn't one this tool wrote"
mkdir -p "$W/r5" "$W/elsewhere"; ln -s "$W/elsewhere" "$W/r5/issues"
refusal "an issues folder that is a link" "$W/r5" "isn't an ordinary folder"
expect "  files written where the link points" "$(find "$W/elsewhere" -type f | wc -l | tr -d ' ')" 0
OUTPUT=$(env -u GTQ_GITHUB_TOKEN node "$TOOLS/github-sync.mjs" --scope "$W/scope.json" --out "$W/r6" 2>&1); CODE=$?
say "- no token"
expect "  exit" "$CODE" 2
expect_has "  message" "$OUTPUT" "GTQ_GITHUB_TOKEN isn't set"
OUTPUT=$(GTQ_GITHUB_TOKEN=pretend-token node "$TOOLS/github-sync.mjs" --api "https://example.invalid" --scope "$W/scope.json" --out "$W/r7" 2>&1); CODE=$?
say "- a server other than GitHub or this computer"
expect "  exit" "$CODE" 2
expect_has "  message" "$OUTPUT" "--api must be https://api.github.com"

say ""
say "8. Read-only: the synchronization makes every request through one function, always GET."
expect "places that call fetch" "$(grep -c 'await fetch(' "$TOOLS/github-sync.mjs")" 1
expect "request methods named" "$(grep -o 'method: "[A-Z]*"' "$TOOLS/github-sync.mjs" | sort -u | tr '\n' ' ')" 'method: "GET" '

say ""
say "$OK expectations as expected, $BAD unexpected."
say "End of record."
sed -e "s#$W#<temp>#g" -e "s#$ROOT#<repo>#g" -e "s#$HOME#~#g" "$REC" > "$LOG.new" && mv "$LOG.new" "$LOG"
cat "$LOG"
[ "$BAD" -eq 0 ]
