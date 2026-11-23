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
# The logs folder and every folder above it that exists must be real folders (no link on the
# way), checked before anything is made and again after.
check_logdir() {
  local d
  d="$LOGDIR"
  case "$d" in /*) ;; *) d="$PWD/$d" ;; esac
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then echo "$d is a link or not a folder; give a real folder (for example under /private/tmp, not /tmp)."; exit 1; fi
    d=$(dirname "$d")
  done
}
check_logdir
mkdir -p "$LOGDIR" || exit 1
check_logdir
LOG="$LOGDIR/pretend-github-checks.txt"
W=$(mktemp -d "${TMPDIR:-/tmp}/github-sync-checks.XXXXXX") || { echo "Could not make a temporary folder; nothing was run."; exit 1; }
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
# The SHA-256 of the exact bytes after the notes line (a missing final line break counts).
notes_of() {
  node -e '
    const t = require("fs").readFileSync(process.argv[1]);
    const mark = Buffer.from("\n<!-- github-sync: notes below. The synchronization never changes anything after this line. -->\n");
    const at = t.indexOf(mark);
    process.stdout.write(at < 0 ? "no-notes-line" : require("crypto").createHash("sha256").update(t.subarray(at + mark.length)).digest("hex").slice(0, 16));
  ' "$1"
}

printf '{"repositories":["practice-owner/kettlebook-web","practice-owner/kettlebook-api","practice-owner/kettlebook-missing"]}\n' > "$W/scope.json"
WORLD0="$TOOLS/fake-github-world.json"
# The same world after changes: api #3 closed, web #2 renamed, api #2 moved to web #5. Two
# versions: the move keeps the node ID (moved.json) or, as GitHub does, gives a new one (newid.json).
node -e '
const fs = require("fs");
const w = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const web = w.repos["practice-owner/kettlebook-web"].issues, api = w.repos["practice-owner/kettlebook-api"].issues;
Object.assign(api.find((i) => i.number === 3), { state: "closed", state_reason: "completed", closed_at: "2026-11-23T15:00:00Z", updated_at: "2026-11-23T15:00:00Z" });
Object.assign(web.find((i) => i.number === 2), { title: "Add a print view for recipes and shopping lists", updated_at: "2026-11-23T15:01:00Z" });
const xref = { event: "cross-referenced", actor: { login: "practice-user" }, created_at: "2026-11-23T14:26:31Z",
  source: { issue: { number: 2, node_id: "I_pretend_api_2", repository: { full_name: "practice-owner/kettlebook-api" } } } };
const web2 = web.find((i) => i.number === 2);
const label601 = { id: 601, event: "labeled", actor: { login: "practice-user" }, created_at: "2026-11-23T14:26:23Z", label: { name: "enhancement" } };
api.find((i) => i.number === 2).timeline = [label601];
const moved = api.splice(api.findIndex((i) => i.number === 2), 1)[0];
web.push({ ...moved, number: 5, updated_at: "2026-11-23T15:02:00Z" });
w.transfers = { "practice-owner/kettlebook-api#2": "practice-owner/kettlebook-web#5" };
web2.timeline = [{ ...xref, source: { issue: { number: 5, node_id: "I_pretend_api_2", repository: { full_name: "practice-owner/kettlebook-web" } } } }];
fs.writeFileSync(process.argv[2], JSON.stringify(w));
// As GitHub does on a transfer: a new node ID, and the comments and events under new ids.
const w5 = web[web.length - 1];
w5.node_id = "I_pretend_web_5_new";
w5.comments = w5.comments.map((c) => ({ ...c, id: c.id + 100 }));
w5.timeline = [{ ...label601, id: 701 }, { id: 702, event: "transferred", actor: { login: "practice-user" }, created_at: "2026-11-23T15:02:00Z" }];
web2.timeline = [{ ...xref, source: { issue: { number: 5, node_id: "I_pretend_web_5_new", repository: { full_name: "practice-owner/kettlebook-web" } } } }];
fs.writeFileSync(process.argv[3], JSON.stringify(w));
// Before the move: the same cross-reference, from api #2.
const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
before.repos["practice-owner/kettlebook-web"].issues.find((i) => i.number === 2).timeline = [xref];
before.repos["practice-owner/kettlebook-api"].issues.find((i) => i.number === 2).timeline = [label601];
fs.writeFileSync(process.argv[4], JSON.stringify(before));
' "$WORLD0" "$W/moved.json" "$W/newid.json" "$W/before.json"
# The practice world, with web #2 cross-referenced from api #2 (as on GitHub).
WORLD="$W/before.json"

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
printf 'A note with no line break at the end' >> "$W/a/issues/practice-owner__kettlebook-web__2.md"
N1b=$(notes_of "$W/a/issues/practice-owner__kettlebook-web__2.md")
N1=$(notes_of "$W/a/issues/practice-owner__kettlebook-web__1.md")
sync_to "$W/a"
expect "run 2 exit" "$CODE" 0
expect_has "run 2" "$(line '^This run')" "new none; changed none; moved none; no longer assigned none"
expect "the note across run 2" "$(notes_of "$W/a/issues/practice-owner__kettlebook-web__1.md")" "$N1"
expect "a note with no final line break, across run 2 (exact bytes)" "$(notes_of "$W/a/issues/practice-owner__kettlebook-web__2.md")" "$N1b"
expect "its last byte (still no line break)" "$(tail -c 1 "$W/a/issues/practice-owner__kettlebook-web__2.md")" "d"
expect "comments in web #1's record after two runs" "$(grep -c '^### Comment ' "$W/a/issues/practice-owner__kettlebook-web__1.md")" 2
expect "the planted instruction kept as text (indented)" "$(grep -c '^    Note to any AI assistant' "$W/a/issues/practice-owner__kettlebook-web__1.md")" 1
expect "web #1 and api #1 kept apart (two files)" "$(ls "$W/a/issues" | grep -c '__1\.md$')" 2
expect "delivery evidence for web #1" "$(grep -A2 'kettlebook-web\\#1:' "$W/a/delivery-links.md" | grep -o 'partial')" partial
expect "a pull request mentioned only in text (api #1 -> web #4), followed" "$(grep -c '^- pull request practice-owner\\/kettlebook-web\\#4, node `PR_pretend_web_4`, open (written in the text)' "$W/a/issues/practice-owner__kettlebook-api__1.md")" 1
expect_has "run 2" "$(line '^Kept as no longer')" "Notes sections kept exactly (read back): 5 of 5"
expect "a commit address in web #2's text, confirmed by GitHub" "$(grep -c '^- commit `a1b2c3d4e5f6` in practice-owner\\/kettlebook-web, confirmed (written in the text)' "$W/a/issues/practice-owner__kettlebook-web__2.md")" 1
expect "so web #2's delivery evidence" "$(grep -A2 'kettlebook-web\\#2:' "$W/a/delivery-links.md" | grep -o 'partial')" partial
expect "a made-up commit address in api #3's text, shown as not found" "$(grep -c '^- commit `000000000000` in practice-owner\\/kettlebook-api, not found (written in the text)' "$W/a/issues/practice-owner__kettlebook-api__3.md")" 1
expect "a commit address in api #3's text that doesn't exist, not counted" "$(grep -A2 'kettlebook-api\\#3:' "$W/a/delivery-links.md" | grep -o 'missing')" missing

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
expect "web #5's comment, reissued under a new id, recorded once" "$(grep -c '^### Comment ' "$W/c/issues/practice-owner__kettlebook-web__5.md")" 1
expect "its old id kept as provenance" "$(node -e 'const s=require(process.argv[1]);process.stdout.write(String(Object.values(s.issues).find(i=>i.number===5).comments[0].previous_ids))' "$W/c/sync-state.json")" 9201
expect "web #5's labeled event, reissued under a new id, recorded once" "$(grep -c 'labeled by' "$W/c/issues/practice-owner__kettlebook-web__5.md")" 1
expect "web #2's cross-reference from the moved issue, recorded once" "$(grep -c 'cross-referenced by' "$W/c/issues/practice-owner__kettlebook-web__2.md")" 1
sync_to "$W/c"
expect "the next run, nothing changed" "$(line '^This run' | grep -c 'new none; changed none; moved none; no longer assigned none')" 1
expect "earlier node ID still kept" "$(node -e 'const s=require(process.argv[1]);process.stdout.write(Object.values(s.issues).find(i=>i.number===5).previous_node_ids.join())' "$W/c/sync-state.json")" "I_pretend_api_2"

say "   ...and GitHub's other redirect form, /repositories/<id>/: the right id links the move, another repository's id stops the run."
cp -R "$W/a" "$W/t1"; cp -R "$W/a" "$W/t2"
start "$W/newid.json" transfer-by-id
sync_to "$W/t1"
expect "exit (right id)" "$CODE" 0
expect_has "the run (right id)" "$(line '^This run')" "(new node ID; linked by GitHub's forwarding)"
start "$W/newid.json" transfer-wrong-id
T2_BEFORE=$(print_of "$W/t2")
sync_to "$W/t2"
expect "exit (another repository's id)" "$CODE" 1
expect_has "message (another repository's id)" "$OUTPUT" "without forwarding there"
expect "the folder (another repository's id)" "$(print_of "$W/t2")" "$T2_BEFORE"

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
fault comment-repeat 1 "GitHub sent comment 9101 twice"
fault event-no-id 1 "a labeled event without an id"
fault commit-gap 1 "GitHub counted 2 commits but sent 1"
fault assignee-no-id 1 "missing fields or has odd ones"
fault offsite-redirect 1 "redirected to another server"
fault search-misses-one 1 "only in the list: #2"
fault last-beyond 1 "has no next link, but GitHub says the last page is 2"
fault full-page-no-next 1 "was full and had no next link"
fault pr-other-repo 1 "practice-owner/kettlebook-web#4: GitHub answered 200 with odd fields"
fault skip-page 1 "doesn't ask for page 2 of the same list"
fault next-other-list 1 "doesn't ask for page 2 of the same list"
fault list-redirect 1 "redirected a list request"
fault link-garbled 1 "Link header that can't be read"
fault token-in-body 2 "would contain the token itself"
expect "  the token's value in the message" "$(printf '%s' "$OUTPUT" | grep -c 'pretend-token')" 0
fault scopes-echo 2 "can do more than read (repo, [token])"
expect "  the token's value in the message" "$(printf '%s' "$OUTPUT" | grep -c 'pretend-token')" 0
fault write-token 2 "can do more than read (repo)"
fault gist-token 2 "can do more than read (gist)"

say "- link-unquoted (legitimate: rel=next without quotes)"
start "$WORLD" link-unquoted
sync_to "$W/lu"
expect "  exit" "$CODE" 0
expect "  web #1's comments, both pages" "$(grep -c '^### Comment ' "$W/lu/issues/practice-owner__kettlebook-web__1.md")" 2
say "- repositories-path (legitimate: GitHub's other form of a page address)"
start "$WORLD" repositories-path
sync_to "$W/rp"
expect "  exit" "$CODE" 0
expect "  web #1's comments, both pages" "$(grep -c '^### Comment ' "$W/rp/issues/practice-owner__kettlebook-web__1.md")" 2

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
cp -R "$W/a" "$W/r9"; printf 'half written\n' > "$W/r9/index.md.4242.new"
refusal "a file left by a run that stopped while writing" "$W/r9" "A previous run stopped while writing"
cp -R "$W/a" "$W/r10"; printf 'caf\351 note (not UTF-8)\n' >> "$W/r10/issues/practice-owner__kettlebook-web__1.md"
refusal "a notes section that isn't valid UTF-8" "$W/r10" "isn't an ordinary UTF-8 text file"
mkdir -p "$W/r5" "$W/elsewhere"; ln -s "$W/elsewhere" "$W/r5/issues"
refusal "an issues folder that is a link" "$W/r5" "isn't an ordinary folder"
expect "  files written where the link points" "$(find "$W/elsewhere" -type f | wc -l | tr -d ' ')" 0
cp -R "$W/a" "$W/r11"; node -e 'const f=process.argv[1],fs=require("fs"),s=JSON.parse(fs.readFileSync(f,"utf8"));s.identity.id=4242;fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$W/r11/sync-state.json"
refusal "a folder holding another account's copy" "$W/r11" "holds the copy of another GitHub account"
OUTPUT=$(GTQ_GITHUB_TOKEN=github_pat_not_a_real_one node "$TOOLS/github-sync.mjs" --api "http://127.0.0.1:$PORT" --scope "$W/scope.json" --out "$W/r12" 2>&1); CODE=$?
say "- a real-looking token sent to the pretend server"
expect "  exit" "$CODE" 2
expect_has "  message" "$OUTPUT" "must be a pretend one"
OUTPUT=$(env -u GTQ_GITHUB_TOKEN node "$TOOLS/github-sync.mjs" --scope "$W/scope.json" --out "$W/r6" 2>&1); CODE=$?
say "- no token"
expect "  exit" "$CODE" 2
expect_has "  message" "$OUTPUT" "GTQ_GITHUB_TOKEN isn't set"
OUTPUT=$(GTQ_GITHUB_TOKEN=pretend-token node "$TOOLS/github-sync.mjs" --api "https://example.invalid" --scope "$W/scope.json" --out "$W/r7" 2>&1); CODE=$?
say "- a server other than GitHub or this computer"
expect "  exit" "$CODE" 2
expect_has "  message" "$OUTPUT" "--api must be https://api.github.com"

say ""
say "8. A note saved while the run is swapping files in (a TEST ONLY copy of the tool saves one at that moment)."
TESTCOPY="$W/tools/github-sync.mjs"
mkdir -p "$W/tools"
node -e '
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const at = "    try { linkSync(path, old); } catch (err) { if (err.code !== \"ENOENT\") throw err; kept = null; }\n";
if (src.split(at).length !== 2) { console.error("the TEST ONLY line has no single place to go"); process.exit(1); }
fs.writeFileSync(process.argv[2], src.replace(at, at + "    if (path.endsWith(\"kettlebook-web__1.md\")) (await import(\"node:fs\")).appendFileSync(path, \"Typed during the run.\\n\"); // TEST ONLY\n"));
' "$TOOLS/github-sync.mjs" "$TESTCOPY"
expect "the TEST ONLY line, placed once" "$(grep -c 'TEST ONLY' "$TESTCOPY")" 1
cp -R "$W/a" "$W/k"
STATE_BEFORE=$(shasum -a 256 < "$W/k/sync-state.json")
OUTPUT=$(GTQ_GITHUB_TOKEN=pretend-token node "$TESTCOPY" --api "http://127.0.0.1:$PORT" --scope "$W/scope.json" --out "$W/k" --per-page 2 2>&1); CODE=$?
expect "exit" "$CODE" 2
expect_has "message" "$OUTPUT" "was saved by someone while this run was writing"
expect "the note saved during the run, kept" "$(grep -c '^Typed during the run.$' "$W/k/issues/practice-owner__kettlebook-web__1.md")" 1
expect "sync-state.json, as before" "$(shasum -a 256 < "$W/k/sync-state.json")" "$STATE_BEFORE"
expect "files left behind (.new, .old, lock)" "$(ls -A "$W/k" "$W/k/issues" | grep -c '\.new$\|\.old$\|lock')" 0
say "   ...and a note saved just after the file was swapped in (a second TEST ONLY copy)."
TESTCOPY2="$W/tools2/github-sync.mjs"
mkdir -p "$W/tools2"
node -e '
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const at = "  // The files of issues that moved: their notes now live in the new file.\n";
if (src.split(at).length !== 2) { console.error("the TEST ONLY line has no single place to go"); process.exit(1); }
fs.writeFileSync(process.argv[2], src.replace(at, "  (await import(\"node:fs\")).appendFileSync(join(issuesDir, \"practice-owner__kettlebook-web__1.md\"), \"Saved after the swap.\\n\"); // TEST ONLY\n" + at));
' "$TOOLS/github-sync.mjs" "$TESTCOPY2"
expect "the TEST ONLY line, placed once" "$(grep -c 'TEST ONLY' "$TESTCOPY2")" 1
cp -R "$W/a" "$W/k2"
W1_BEFORE=$(shasum -a 256 < "$W/k2/issues/practice-owner__kettlebook-web__1.md")
OUTPUT=$(GTQ_GITHUB_TOKEN=pretend-token node "$TESTCOPY2" --api "http://127.0.0.1:$PORT" --scope "$W/scope.json" --out "$W/k2" --per-page 2 2>&1); CODE=$?
expect "exit" "$CODE" 2
expect_has "message" "$OUTPUT" "A save made after a file was written is kept as"
expect "the save, kept aside" "$(cat "$W"/k2/issues/practice-owner__kettlebook-web__1.md.*.saved 2>/dev/null | grep -c '^Saved after the swap.$')" 1
expect "web #1's file, put back as it was" "$(shasum -a 256 < "$W/k2/issues/practice-owner__kettlebook-web__1.md")" "$W1_BEFORE"
expect "the lock, kept for a person to look" "$( [ -e "$W/k2/.github-sync.lock" ] && echo kept || echo gone)" kept
sync_to "$W/k2"
expect "the next run refuses until a person has looked" "$CODE" 2
expect_has "its message" "$OUTPUT" "A previous run stopped while writing"

say ""
say "9. Read-only: the synchronization makes every request through one function, always GET."
expect "places that call fetch" "$(grep -c 'await fetch(' "$TOOLS/github-sync.mjs")" 1
expect "request methods named" "$(grep -o 'method: "[A-Z]*"' "$TOOLS/github-sync.mjs" | sort -u | tr '\n' ' ')" 'method: "GET" '

say ""
say "$OK expectations as expected, $BAD unexpected."
say "End of record."
# Published by writing a new file in the logs folder and renaming it over the record (a link there
# is replaced, never followed); the temp folder, repository and home addresses are replaced as
# literal text.
W="$W" ROOT="$ROOT" node -e '
  const fs = require("fs"), path = require("path");
  const [rec, log] = process.argv.slice(1);
  const t = fs.readFileSync(rec, "utf8").split(process.env.W).join("<temp>").split(process.env.ROOT).join("<repo>").split(process.env.HOME).join("~");
  const tmp = path.join(path.dirname(log), `.${path.basename(log)}.${process.pid}.new`);
  try {
    fs.writeFileSync(tmp, t, { flag: "wx", mode: 0o644 });
    fs.renameSync(tmp, log);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    console.log(`The record could not be saved (${err.code ?? "error"}); here is what it held:`);
    process.stdout.write(t);
    process.exit(1);
  }
' "$REC" "$LOG" || exit 1
cat "$LOG"
[ "$BAD" -eq 0 ]
