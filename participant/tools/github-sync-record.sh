#!/usr/bin/env bash
# Records the real runs of the GitHub synchronization for the quest's evidence. Tom runs it in
# the terminal that holds the read-only token (GTQ_GITHUB_TOKEN); the token is never printed or
# put on a command line, and each record is checked for it before it is kept.
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
# Each mode exits 0 only if everything it checks held; the record is kept either way, so a failure
# can be looked at. Records go to participant/evidence/github-read-assigned-issues/github-attempt-002/logs/.

set -uo pipefail
set +x   # never trace: a trace would print the token

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOGS="$ROOT/participant/evidence/github-read-assigned-issues/github-attempt-002/logs"
OUT="$ROOT/participant/context/github/assigned"
SYNC=(node "$ROOT/participant/tools/github-sync.mjs" --per-page 2)
MODE=${1:-}

if [ -z "${GTQ_GITHUB_TOKEN:-}" ]; then
  echo "GTQ_GITHUB_TOKEN isn't loaded in this terminal. Run: read -rs GTQ_GITHUB_TOKEN && export GTQ_GITHUB_TOKEN"
  exit 2
fi
# The logs folder must be a real folder inside the repository, with no link anywhere on the way:
# the folders that already exist are checked before any is made, and all of them again after.
check_logs_path() {
  local d="$LOGS"
  while [ "$d" != "$ROOT" ]; do
    if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then echo "${d#$ROOT/} isn't an ordinary folder (a link?); nothing was recorded."; exit 2; fi
    d=$(dirname "$d")
  done
}
check_logs_path
mkdir -p "$LOGS" || exit 2
check_logs_path
# Each record is first built in a private temporary file (made new, owner-only), removed on exit.
RAW=$(mktemp "${TMPDIR:-/tmp}/gtq-record.XXXXXX") || { echo "Could not make a temporary file; nothing was recorded."; exit 2; }
trap 'rm -f -- "$RAW"' EXIT

# The request headers, printed by the shell itself (no separate program sees the token).
auth() { printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\n' "$GTQ_GITHUB_TOKEN"; }
stamp() { date '+%m-%d-%Y %-I:%M %p %Z'; }
# Finish a record: hide this computer's folders (replaced as literal text), refuse if the token is
# in it (its value is never printed), then publish it by writing a new file in the logs folder and
# renaming it over the record, so an existing link there is replaced, never followed. The raw
# text stays in the temporary file until the record is safely in place.
finish() { # raw file, record
  ROOT="$ROOT" node -e '
    const fs = require("fs"), path = require("path");
    const [raw, rec] = process.argv.slice(1);
    let t = fs.readFileSync(raw, "utf8");
    if (process.env.GTQ_GITHUB_TOKEN && t.includes(process.env.GTQ_GITHUB_TOKEN)) { console.log("The token appeared in the record, so it was not kept."); process.exit(3); }
    t = t.split(process.env.ROOT).join("<repo>").split(process.env.HOME).join("~");
    const tmp = path.join(path.dirname(rec), `.${path.basename(rec)}.${process.pid}.new`);
    try {
      fs.writeFileSync(tmp, t, { flag: "wx", mode: 0o644 });
      fs.renameSync(tmp, rec);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      console.log(`The record could not be saved (${err.code ?? "error"}); here is what it held:`);
      process.stdout.write(t);
      process.exit(4);
    }
  ' "$1" "$2"
  local rc=$?
  [ "$rc" = 0 ] || exit 3   # 3: the token was in it (nothing shown or kept); 4: shown above, not saved
}
# One line per issue file: the SHA-256 of the exact bytes after its notes line.
notes_hashes() {
  node -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const dir = path.join(process.argv[1], "issues");
    const mark = Buffer.from("\n<!-- github-sync: notes below. The synchronization never changes anything after this line. -->\n");
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch {}
    for (const n of names) {
      // Opened once without following a link or waiting on a pipe, and checked as an ordinary file.
      let fd;
      try { fd = fs.openSync(path.join(dir, n), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
      catch (err) { console.error(`issues/${n} cannot be opened safely (${err.code}); stopped.`); process.exit(1); }
      if (!fs.fstatSync(fd).isFile()) { console.error(`issues/${n} is not an ordinary file; stopped.`); process.exit(1); }
      const t = fs.readFileSync(fd);
      fs.closeSync(fd);
      const at = t.indexOf(mark);
      const h = at < 0 ? "no-notes-line" : crypto.createHash("sha256").update(t.subarray(at + mark.length)).digest("hex");
      console.log(`${h}  ${n}`);
    }
  ' "$OUT"
}
# Compares the notes hashes issue by issue: each file's notes before must be the same file's notes
# after, or, for an issue that moved, its new file's (found through moved_from in sync-state.json).
# Exits 1 if any differs or is missing.
compare_notes() { # before-lines, after-lines
  BEFORE="$1" AFTER="$2" node -e '
    const fs = require("fs");
    const parse = (t) => new Map(t.split("\n").filter(Boolean).map((l) => { const [h, f] = l.split(/  /); return [f, h]; }));
    const before = parse(process.env.BEFORE), after = parse(process.env.AFTER);
    let state = { issues: {} };
    try { state = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    const movedTo = new Map();
    for (const r of Object.values(state.issues)) for (const m of r.moved_from ?? []) movedTo.set(`${m.repository.replace("/", "__")}__${m.number}.md`, r.file);
    let bad = 0;
    for (const [f, h] of before) {
      const to = after.has(f) ? f : movedTo.get(f);
      const ok = to !== undefined && after.get(to) === h && h !== "no-notes-line";
      if (!ok) bad++;
      console.log(`  ${f}${to && to !== f ? ` -> ${to}` : ""}: ${ok ? "same" : "DIFFERS or missing"}`);
    }
    if (bad || before.size === 0) { console.log("Check: a notes section DIFFERS or is missing."); process.exit(1); }
    console.log("Check: every notes section is byte-identical, issue by issue (a moved issue'"'"'s in its new file).");
  ' "$OUT/sync-state.json"
}
section() { awk -v start="$2" -v stop="$3" '$0 == start {f=1; next} stop != "" && $0 == stop {f=0} f && NF' "$1"; }

case "$MODE" in
  token-check)
    REC="$LOGS/token-check.txt"
    BAD=0
    field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(typeof v==="string"?v:"")}catch{}})' "$1"; }
    # A refusal counts only with GitHub's own reason for a token without that permission; another
    # 403 (a rate limit, a protected branch) proves nothing. After the first write that isn't
    # refused that way, no further write is tried.
    probe() { # what, method, url, body, undo-hint
      [ "$BAD" = 0 ] || { echo "$1: not tried (an earlier check failed)."; return; }
      local out code msg
      out=$(printf '%s' "$4" | curl -s -w '\n%{http_code}' -X "$2" -H @<(auth) "$3" --data-binary @-)
      code=${out##*$'\n'}
      msg=$(printf '%s' "${out%$'\n'*}" | field message)
      msg=${msg//"$GTQ_GITHUB_TOKEN"/[token]}
      if [ "$code" = "403" ] && [ "$msg" = "Resource not accessible by personal access token" ]; then
        echo "$1: GitHub answered 403, \"$msg\": refused for lack of permission."
      else
        BAD=1
        echo "$1: GitHub answered $code${msg:+, \"$msg\"}: NOT a permission refusal. $5"
      fi
    }
    echo "This check sends three write requests with the token, to the web practice repository only:"
    echo "  create a label \"token-write-test\"; set pull request #4's title to the title it already has;"
    echo "  create a file token-write-test.md. A read-only token makes GitHub refuse all three. If the"
    echo "  token can write, the first may go through (the record then says what to undo)."
    printf 'Type yes to send them: '
    read -r ANSWER
    [ "$ANSWER" = "yes" ] || { echo "Nothing was sent."; exit 1; }
    {
      echo "Token check, $(stamp). Git commit $(git -C "$ROOT" rev-parse --short HEAD)."
      echo "The token was given Contents, Issues and Pull requests, read-only (Metadata is read-only"
      echo "by design). It must read, and GitHub must refuse one harmless write for each of the three."
      OWNER=$(curl -s -H @<(auth) https://api.github.com/user | field login)
      WEBR="https://api.github.com/repos/$OWNER/gtq-practice-kettlebook-web"
      echo "The token belongs to: ${OWNER:-unknown}"
      READ=$(curl -s -o /dev/null -w '%{http_code}' -H @<(auth) "$WEBR/issues/1")
      echo "Read issue #1: GitHub answered $READ (200 expected)."
      TITLE=$(curl -s -H @<(auth) "$WEBR/pulls/4" | field title)
      BRANCH=$(curl -s -H @<(auth) "$WEBR" | field default_branch)
      if [ -z "$OWNER" ] || [ "$READ" != "200" ] || [ -z "$TITLE" ] || [ -z "$BRANCH" ]; then
        BAD=1
        echo "The token couldn't read what the check needs (login, issue #1, pull request #4, the default branch); no write was tried."
      else
        probe "Issues write (create a label)" POST "$WEBR/labels" '{"name":"token-write-test","color":"ffffff"}' "Delete the label token-write-test."
        probe "Pull requests write (set #4's title to its own title)" PATCH "$WEBR/pulls/4" \
          "$(TITLE="$TITLE" node -e 'process.stdout.write(JSON.stringify({title: process.env.TITLE}))')" "Nothing to undo (the title is unchanged)."
        probe "Contents write (create token-write-test.md)" PUT "$WEBR/contents/token-write-test.md" \
          "$(BR="$BRANCH" node -e 'process.stdout.write(JSON.stringify({message:"token write test",content:"dGVzdAo=",branch:process.env.BR}))')" "Delete token-write-test.md."
      fi
      if [ "$BAD" = 0 ]; then
        echo "Result: it reads, and every write was refused for the three permissions the token holds."
      else
        echo "Result: NOT confirmed read-only (see above). If a write went through, delete the token on GitHub and make a read-only one."
      fi
      echo "End of record."
    } > "$RAW" 2>&1
    finish "$RAW" "$REC"
    cat "$REC"
    exit "$BAD"
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
    } > "$RAW"
    finish "$RAW" "$REC"
    cat "$REC"
    if ! grep -qx 'exit 0' "$REC"; then
      echo "Run 1 didn't finish, so there is nothing to compare. Fix the cause and run this again."
      exit 1
    fi
    echo
    echo "Now write a note: open one issue's file in participant/context/github/assigned/issues/,"
    echo "type something under \"## My notes\", save it, then press Return here."
    read -r _
    B=$(notes_hashes) || exit 1
    {
      cat "$REC"
      echo
      echo "== Notes sections before run 2 (SHA-256 of the exact bytes after each notes line)"
      echo "$B"
      echo
      echo "== Run 2"
      "${SYNC[@]}" 2>&1
      echo "exit $?"
      echo
      echo "== Notes sections after run 2"
      notes_hashes
    } > "$RAW"
    A=$(notes_hashes)
    STATUS=0
    {
      echo
      echo "== Notes, issue by issue"
      compare_notes "$B" "$A" || STATUS=1
      if section "$RAW" "== Run 2" "== Notes sections after run 2" | grep -qx 'exit 0' \
        && section "$RAW" "== Run 2" "== Notes sections after run 2" | grep -q "^This run: new none; changed none; moved none; no longer assigned none; returned none"; then
        echo "Check: run 2 finished, and added, changed, moved and removed nothing."
      else
        STATUS=1
        echo "Check: run 2 failed or reported a change (see its lines above)."
      fi
      echo "End of record."
    } >> "$RAW"
    finish "$RAW" "$REC"
    sed -n '/^== Notes sections before/,$p' "$REC"
    exit "$STATUS"
    ;;
  disappearance)
    REC="$LOGS/disappearance.txt"
    B=$(notes_hashes) || exit 1
    {
      echo "A run after changes on GitHub, $(stamp). Git commit $(git -C "$ROOT" rev-parse --short HEAD). Node $(node --version)."
      echo
      echo "== Notes sections before (SHA-256 of the exact bytes after each notes line)"
      echo "$B"
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
    } > "$RAW"
    A=$(notes_hashes)
    STATUS=0
    {
      echo
      echo "== Notes, issue by issue"
      compare_notes "$B" "$A" || STATUS=1
      if section "$RAW" "== The run" "== Notes sections after" | grep -qx 'exit 0'; then
        echo "Check: the run finished."
      else
        STATUS=1
        echo "Check: the run FAILED (see its lines above); the files are the previous run's."
      fi
      echo "End of record."
    } >> "$RAW"
    finish "$RAW" "$REC"
    cat "$REC"
    exit "$STATUS"
    ;;
  *)
    echo "Usage: bash participant/tools/github-sync-record.sh token-check | two-runs | disappearance"
    exit 2
    ;;
esac
