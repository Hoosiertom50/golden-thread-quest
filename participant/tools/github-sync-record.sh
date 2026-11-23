#!/usr/bin/env bash
# Records the real runs of the GitHub synchronization for the quest's evidence. Tom runs it in
# the terminal that holds the read-only token (GTQ_GITHUB_TOKEN); the token is never printed,
# and each record is checked for it before it is kept.
#
#   bash participant/tools/github-sync-record.sh token-check
#       Proves the token is read-only: one harmless write (creating a label named
#       "token-write-test" in the web practice repository) must be refused by GitHub.
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
      echo "One harmless write with the token: create a label in the web practice repository."
      echo "A read-only token must be refused (403). Nothing else is attempted."
      OWNER=$(curl -s -H @<(auth) https://api.github.com/user | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).login||"")}catch{}})')
      echo "The token belongs to: ${OWNER:-unknown}"
      CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H @<(auth) \
        "https://api.github.com/repos/$OWNER/gtq-practice-kettlebook-web/labels" \
        -d '{"name":"token-write-test","color":"ffffff"}')
      echo "GitHub answered: $CODE"
      if [ "$CODE" = "403" ]; then
        echo "Result: refused, as expected. The token can't write."
      else
        echo "Result: NOT refused. The token can write: delete it on GitHub and make a read-only one."
        [ "$CODE" = "201" ] && echo "(A label named token-write-test was created; delete it in the repository's labels.)"
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
      B=$(awk '/^== Notes sections before/{f=1;next} /^== Run 2/{f=0} f' "$REC")
      A=$(awk '/^== Notes sections after/{f=1;next} f' "$REC")
      if [ -n "$B" ] && [ "$B" = "$A" ]; then echo "Check: every notes section is byte-identical across run 2."; else echo "Check: a notes section DIFFERS across run 2."; fi
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
      # A moved issue's file is renamed, so the hashes are compared as a set, not by file name.
      B=$(awk '/^== Notes sections before/{f=1;next} /^== The run/{f=0} f && NF' "$REC" | cut -c1-64 | sort)
      A=$(awk '/^== Notes sections after/{f=1;next} /^== No longer assigned/{f=0} f && NF' "$REC" | cut -c1-64 | sort)
      if [ -n "$B" ] && [ "$B" = "$A" ]; then echo "Check: every notes section is byte-identical after the run (moved ones under their new file name)."; else echo "Check: the notes sections DIFFER after the run."; fi
      echo "End of record."
    } >> "$REC"
    cat "$REC"
    ;;
  *)
    echo "Usage: bash participant/tools/github-sync-record.sh token-check | two-runs | disappearance"
    exit 2
    ;;
esac
