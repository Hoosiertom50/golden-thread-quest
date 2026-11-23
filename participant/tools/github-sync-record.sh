#!/usr/bin/env bash
# Records the real runs of the GitHub synchronization for the quest's evidence. Tom runs it in
# the terminal that holds the read-only token (GTQ_GITHUB_TOKEN); the token is never printed,
# and each record is checked for it before it is kept.
#
#   bash participant/tools/github-sync-record.sh token-check
#       Checks the token reads, and that GitHub refuses one harmless write for each permission the
#       token was given (Issues: create a label; Pull requests: set pull request #4's title to the
#       title it already has; Contents: create a small file). Each must be refused (403).
#   bash participant/tools/github-sync-record.sh two-runs
#       Run 1, then a pause while you write a note in one issue's file, then run 2. The second
#       run must add and change nothing, and every notes section must be byte-identical.
#   bash participant/tools/github-sync-record.sh disappearance
#       One run after you changed things on GitHub (closed, renamed, transferred).
#
# Records go to participant/evidence/github-read-assigned-issues/github-attempt-002/logs/.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOGS="$ROOT/participant/evidence/github-read-assigned-issues/github-attempt-002/logs"
OUT="$ROOT/participant/context/github/assigned"
SYNC=(node "$ROOT/participant/tools/github-sync.mjs" --per-page 2)
MODE=${1:-}

if [ -z "${GTQ_GITHUB_TOKEN:-}" ]; then
  echo "GTQ_GITHUB_TOKEN isn't loaded in this terminal. Run: read -rs GTQ_GITHUB_TOKEN && export GTQ_GITHUB_TOKEN"
  exit 2
fi
mkdir -p "$LOGS"

# The request headers, printed by the shell itself (no separate program sees the token).
auth() { printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\n' "$GTQ_GITHUB_TOKEN"; }
stamp() { date '+%m-%d-%Y %-I:%M %p %Z'; }
# Hide this computer's folders in the record.
tidy() { sed -e "s#$ROOT#<repo>#g" -e "s#$HOME#~#g"; }
# The token must never be in a record: if it is, the record is removed.
guard() {
  if grep -qF -f <(printf '%s\n' "$GTQ_GITHUB_TOKEN") -- "$1"; then
    rm -f -- "$1"
    echo "The token appeared in the record, so the record was removed. Nothing was kept."
    exit 3
  fi
}
# Compares the notes hashes issue by issue: each file's notes before must be the same file's notes
# after, or, for an issue that moved, its new file's (found through moved_from in sync-state.json).
compare_notes() { # before-lines, after-lines
  BEFORE="$1" AFTER="$2" node -e '
    const fs = require("fs");
    const parse = (t) => new Map(t.split("\n").filter(Boolean).map((l) => { const [h, f] = l.split(/  /); return [f, h]; }));
    const before = parse(process.env.BEFORE), after = parse(process.env.AFTER);
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const movedTo = new Map();
    for (const r of Object.values(state.issues)) for (const m of r.moved_from ?? []) movedTo.set(`${m.repository.replace("/", "__")}__${m.number}.md`, r.file);
    let bad = 0;
    for (const [f, h] of before) {
      const to = after.has(f) ? f : movedTo.get(f);
      const ok = to !== undefined && after.get(to) === h;
      if (!ok) bad++;
      console.log(`  ${f}${to && to !== f ? ` -> ${to}` : ""}: ${ok ? "same" : "DIFFERS or missing"}`);
    }
    console.log(bad || before.size === 0 ? "Check: a notes section DIFFERS or is missing." : "Check: every notes section is byte-identical, issue by issue (a moved issue'"'"'s in its new file).");
  ' "$OUT/sync-state.json"
}
# One line per issue file: the SHA-256 of everything after its notes line.
notes_hashes() {
  local f
  for f in "$OUT"/issues/*.md; do
    [ -f "$f" ] || continue
    printf '%s  %s\n' "$(awk 'found{print} /^<!-- github-sync: notes below/{found=1}' "$f" | shasum -a 256 | cut -c1-64)" "${f##*/}"
  done
}

case "$MODE" in
  token-check)
    REC="$LOGS/token-check.txt"
    {
      echo "Token check, $(stamp). Git commit $(git -C "$ROOT" rev-parse --short HEAD)."
      echo "The token was given Contents, Issues and Pull requests, read-only (Metadata is read-only"
      echo "by design). It must read, and GitHub must refuse one harmless write for each of the three."
      field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(typeof v==="string"?v:"")}catch{}})' "$1"; }
      OWNER=$(curl -s -H @<(auth) https://api.github.com/user | field login)
      WEBR="https://api.github.com/repos/$OWNER/gtq-practice-kettlebook-web"
      echo "The token belongs to: ${OWNER:-unknown}"
      echo "Read issue #1: GitHub answered $(curl -s -o /dev/null -w '%{http_code}' -H @<(auth) "$WEBR/issues/1") (200 expected)."
      TITLE=$(curl -s -H @<(auth) "$WEBR/pulls/4" | field title)
      BRANCH=$(curl -s -H @<(auth) "$WEBR" | field default_branch)
      BAD=0
      probe() { # what, method, url, body, undo-hint
        local code
        code=$(curl -s -o /dev/null -w '%{http_code}' -X "$2" -H @<(auth) "$3" -d "$4")
        if [ "$code" = "403" ]; then echo "$1: GitHub answered 403, refused."; else BAD=1; echo "$1: GitHub answered $code, NOT refused. $5"; fi
      }
      probe "Issues write (create a label)" POST "$WEBR/labels" '{"name":"token-write-test","color":"ffffff"}' "Delete the label token-write-test."
      probe "Pull requests write (set #4's title to its own title)" PATCH "$WEBR/pulls/4" \
        "$(TITLE="$TITLE" node -e 'process.stdout.write(JSON.stringify({title: process.env.TITLE}))')" "Nothing to undo (the title is unchanged)."
      probe "Contents write (create token-write-test.md)" PUT "$WEBR/contents/token-write-test.md" \
        "$(BR="$BRANCH" node -e 'process.stdout.write(JSON.stringify({message:"token write test",content:"dGVzdAo=",branch:process.env.BR}))')" "Delete token-write-test.md."
      if [ "$BAD" = 0 ]; then
        echo "Result: every write was refused for the three permissions the token holds."
      else
        echo "Result: the token can write: delete it on GitHub and make a read-only one."
      fi
      echo "End of record."
    } 2>&1 | tidy > "$REC"
    guard "$REC"
    cat "$REC"
    ;;
  two-runs)
    REC="$LOGS/second-run.txt"
    {
      echo "Two consecutive synchronization runs, $(stamp). Git commit $(git -C "$ROOT" rev-parse --short HEAD). Node $(node --version)."
      echo "Pages of 2 on purpose, so paging shows; for real use the default is 100."
      echo
      echo "== Run 1"
      "${SYNC[@]}" 2>&1
      echo "exit $?"
    } | tidy > "$REC"
    guard "$REC"
    cat "$REC"
    if ! grep -qx 'exit 0' "$REC"; then
      echo "Run 1 didn't finish, so there is nothing to compare. Fix the cause and run this again."
      exit 1
    fi
    echo
    echo "Now write a note: open one issue's file in participant/context/github/assigned/issues/,"
    echo "type something under \"## My notes\", save it, then press Return here."
    read -r _
    {
      echo
      echo "== Notes sections before run 2 (SHA-256 of everything after each notes line)"
      notes_hashes
      echo
      echo "== Run 2"
      "${SYNC[@]}" 2>&1
      echo "exit $?"
      echo
      echo "== Notes sections after run 2"
      notes_hashes
    } | tidy >> "$REC"
    guard "$REC"
    {
      echo
      B=$(awk '/^== Notes sections before/{f=1;next} /^== Run 2/{f=0} f && NF' "$REC")
      A=$(awk '/^== Notes sections after/{f=1;next} f && NF' "$REC")
      echo "== Notes, issue by issue"
      compare_notes "$B" "$A"
      if grep -q "^This run: new none; changed none; moved none; no longer assigned none; returned none" <(awk '/^== Run 2/{f=1} f' "$REC"); then
        echo "Check: run 2 added, changed, moved and removed nothing."
      else
        echo "Check: run 2 reported a change (see its \"This run\" line)."
      fi
      echo "End of record."
    } >> "$REC"
    sed -n '/^== Notes sections before/,$p' "$REC"
    ;;
  disappearance)
    REC="$LOGS/disappearance.txt"
    {
      echo "A run after changes on GitHub, $(stamp). Git commit $(git -C "$ROOT" rev-parse --short HEAD). Node $(node --version)."
      echo
      echo "== Notes sections before"
      notes_hashes
      echo
      echo "== The run"
      "${SYNC[@]}" 2>&1
      echo "exit $?"
      echo
      echo "== Notes sections after"
      notes_hashes
      echo
      echo "== No longer assigned, from the index"
      awk '/^## No longer assigned/{f=1} f' "$OUT/index.md"
    } | tidy > "$REC"
    guard "$REC"
    {
      echo
      B=$(awk '/^== Notes sections before/{f=1;next} /^== The run/{f=0} f && NF' "$REC")
      A=$(awk '/^== Notes sections after/{f=1;next} /^== No longer assigned/{f=0} f && NF' "$REC")
      echo "== Notes, issue by issue"
      compare_notes "$B" "$A"
      echo "End of record."
    } >> "$REC"
    cat "$REC"
    ;;
  *)
    echo "Usage: bash participant/tools/github-sync-record.sh token-check | two-runs | disappearance"
    exit 2
    ;;
esac
