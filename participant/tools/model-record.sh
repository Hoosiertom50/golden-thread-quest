#!/usr/bin/env bash
# Records for the canonical work-item quest, written to the attempt's logs folder. This script
# makes no external reads or writes: no GitHub or Jira calls, and it never needs the token.
#
#   bash participant/tools/model-record.sh unmappable
#       A labelled test copy of the Jira data with statuses the model doesn't know, normalized into
#       a throwaway copy of the model folder.
#
#   bash participant/tools/model-record.sh identity
#       Part 1, Jira: a story renamed and moved to another status (the Jira quest's synchronization
#       against its pretend Jira, offline, in a throwaway folder). Part 2, GitHub, first half: the
#       starting point, Tom's saved note, and the change Tom then makes BY HAND on GitHub's web page.
#   (Tom makes the change, then runs the GitHub quest's own read-only synchronization:
#       node participant/tools/github-sync.mjs)
#   bash participant/tools/model-record.sh identity-after
#       Part 2, second half: checks the synchronization ran, normalizes again, and checks the
#       identity held. It only reads local files.
#
# Saved records never contain this computer's folders (written <repo>, <temp>, ~) and are checked for
# the token if one is loaded. Every "Check:" line states only what was tested just above it.

set -uo pipefail
set +x
MODE=${1:-}
case "$MODE" in unmappable|identity|identity-after) ;; *) echo "Usage: bash participant/tools/model-record.sh unmappable|identity|identity-after"; exit 1 ;; esac
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
LOGS="$ROOT/participant/evidence/context-canonical-work-item/context-attempt-003/logs"
NORM="$ROOT/participant/tools/normalize-work-items.mjs"
MODEL="$ROOT/participant/context/model"
GHSTATE="$ROOT/participant/context/github/assigned/sync-state.json"
STATE="$ROOT/local-data/model-identity-state.json"      # between the two halves (not committed)
PARTIAL="$ROOT/local-data/model-identity-partial.txt"   # the record so far (already redacted)
W=$(mktemp -d "${TMPDIR:-/tmp}/model-record.XXXXXX") || { echo "Could not make a temporary folder."; exit 1; }
W=$(cd "$W" && pwd -P) || exit 1
trap 'rm -rf -- "${W:?}"' EXIT
REC="$W/record.txt"
export TZ=America/New_York   # every time shown in one fixed zone, as the normalizer does
stamp() { date '+%m-%d-%Y %-I:%M %p %Z'; }
# An ISO time as MM-DD-YYYY h:mm AM/PM with its zone.
showtime() { node -e 'const d = new Date(process.argv[1]); if (isNaN(d)) { console.log("an unknown time"); process.exit(0); } const p = (n) => String(n).padStart(2, "0"); const h = d.getHours(); console.log(`${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()} ${h % 12 || 12}:${p(d.getMinutes())} ${h < 12 ? "AM" : "PM"} ${d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop()}`)' "$1"; }
tree() {
  local out
  out=$(git -C "$ROOT" status --porcelain 2>/dev/null) || { echo "git status unavailable"; return; }
  if [ -n "$out" ]; then echo "with uncommitted changes"; else echo "nothing uncommitted"; fi
}
commit() { git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown"; }
say() { printf '%s\n' "$*" | tee -a "$REC"; }
run() { "$@" 2>&1 | tee -a "$REC"; return "${PIPESTATUS[0]}"; }
ask() { read -r REPLY || { echo; echo "No input; stopping."; exit 1; }; }
is_hash() { case "$1" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) [ "${#1}" = 64 ] ;; *) return 1 ;; esac; }
# The person's part of a record: everything after its one "## My analysis" line, as a SHA-256.
analysis_sha() { python3 -c '
import hashlib, sys
try: raw = open(sys.argv[1], "rb").read()
except OSError: sys.exit(1)
lines = raw.split(b"\n")
at = [n for n, l in enumerate(lines) if l == b"## My analysis"]
if len(at) != 1: sys.exit(1)
print(hashlib.sha256(b"\n".join(lines[at[0] + 1:])).hexdigest())' "$1"; }
has_note() { python3 -c '
import sys
try: raw = open(sys.argv[1], "rb").read()
except OSError: sys.exit(1)
lines = raw.split(b"\n")
at = [n for n, l in enumerate(lines) if l == b"## My analysis"]
if len(at) != 1: sys.exit(1)
t = b"\n".join(lines[at[0] + 1:]).decode("utf-8", "ignore")
sys.exit(0 if any(c.isalnum() for c in t) else 1)' "$1"; }
# A field of a record's table, with the Markdown escapes taken off (the plain value).
field() { python3 -c '
import sys, re
for line in open(sys.argv[1], encoding="utf-8"):
    m = re.match(r"\| " + re.escape(sys.argv[2]) + r" \| (.*) \|$", line.rstrip("\n"))
    if m: print(re.sub(r"\\(.)", r"\1", m.group(1)).replace("`", "")); break' "$1" "$2"; }
inode() { python3 -c 'import os, sys; print(os.stat(sys.argv[1]).st_ino)' "$1"; }
folder_sha() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | shasum -a 256 | cut -d' ' -f1; }
count_github() { grep -l '^| system | github |$' "$MODEL/items/"*.md | wc -l | tr -d ' '; }
count_id() { grep -l "^| id | \`$2\` |\$" "$1/"*.md | wc -l | tr -d ' '; }
tools_line() {
  local t
  for t in normalize-work-items.mjs model-record.sh jira-sync.mjs github-sync.mjs; do
    printf '%s %s ' "$t" "$(shasum -a 256 "$ROOT/participant/tools/$t" | cut -c1-12)"
  done
}
token_free() { python3 -c '
import os, sys
tok = os.environ.get("GTQ_GITHUB_TOKEN", "")
for top in sys.argv[1:]:
    for d, _, files in os.walk(top):
        for f in files:
            try: data = open(os.path.join(d, f), "rb").read()
            except OSError: print("unreadable: " + os.path.join(d, f)); sys.exit(1)
            if tok and tok.encode() in data: print(os.path.join(d, f)); sys.exit(1)' "$@"; }
# Save $REC to $1 with this computer's folders rewritten, refusing if the token is in it.
save() {
  ROOT="$ROOT" W="$W" python3 -c '
import os, sys
t = open(sys.argv[1], encoding="utf-8").read()
tok = os.environ.get("GTQ_GITHUB_TOKEN", "")
if tok and tok in t: sys.exit("the record would contain the token; not saved")
forms = []
for key, label in (("W", "<temp>"), ("ROOT", "<repo>")):
    p = os.environ[key]
    forms += [(p, label)]
    if p.startswith("/private/"): forms += [(p[len("/private"):], label)]
forms += [(os.path.expanduser("~"), "~")]
for p, label in sorted(forms, key=lambda x: -len(x[0])): t = t.replace(p, label)
for leak in ("/Users/", "/private/", "/var/folders", os.path.expanduser("~") + "/"):
    if leak in t: sys.exit("the record still names a folder of this computer (" + leak + "); not saved")
out = sys.argv[2]; tmp = os.path.join(os.path.dirname(out), "." + os.path.basename(out) + ".new")
with open(tmp, "w", encoding="utf-8") as f: f.write(t)
os.replace(tmp, out)' "$REC" "$1" || { echo "The record could not be saved."; return 1; }
}
stop() { say "$1"; say "End of record."; save "$OUTFILE" && echo "Saved: ${OUTFILE#"$ROOT"/}"; exit 1; }
mkdir -p "$LOGS" "$ROOT/local-data" || exit 1
OUTFILE="$LOGS/identity-check.txt"

case "$MODE" in
unmappable)
  OUTFILE="$LOGS/unmappable.txt"
  say "Normalizing items the model can't represent, $(stamp). Git commit $(commit), $(tree). Node $(node --version)."
  say "Tools (SHA-256, first 12): $(tools_line)"
  say "Input: a TEST COPY of the synchronized Jira data, constructed for this check (the real copy is"
  say "only read). In it, GTQ-102 (which already has a record) gets the status \"Waiting for Customer\","
  say "a new story GTQ-150 gets the same status, and a new story GTQ-151 has an empty summary. The"
  say "normalization runs on a throwaway copy of the model folder; the real model folder is checked"
  say "unchanged at the end."
  cp -R "$MODEL" "$W/model" && mkdir "$W/jira" && cp "$ROOT/participant/context/jira/assigned/sync-summary.json" "$W/jira/" || stop "Could not prepare the throwaway copies."
  rm -f "$W/model/.normalize.lock"
  python3 -c '
import json, sys, copy
d = json.load(open(sys.argv[1]))
d["test_copy"] = "Constructed for the unmappable check; not a synchronization result."
by = {s["key"]: s for s in d["stories"]}
by["GTQ-102"]["status"] = "Waiting for Customer"
a = copy.deepcopy(by["GTQ-101"]); a.update(key="GTQ-150", summary="Fixture story GTQ-150 (test copy)", status="Waiting for Customer", source_url="https://jira.example.invalid/browse/GTQ-150")
b = copy.deepcopy(by["GTQ-101"]); b.update(key="GTQ-151", summary="", source_url="https://jira.example.invalid/browse/GTQ-151")
d["stories"] += [a, b]
json.dump(d, open(sys.argv[2], "w"), indent=2)' "$ROOT/participant/context/jira/assigned/stories.json" "$W/jira/stories.json" || stop "Could not build the test copy."
  REAL_BEFORE=$(folder_sha "$MODEL") || stop "Could not fingerprint the real model folder."
  JIRA_BEFORE=$(folder_sha "$ROOT/participant/context/jira") || stop "Could not fingerprint the real Jira copy."
  F102="$W/model/items/jira__GTQ-102.md"; F101="$W/model/items/jira__GTQ-101.md"
  grep -q '^> \*\*Not refreshed:\*\*' "$F102" && stop "GTQ-102's record already says Not refreshed; the check needs a fresh one."
  echo "Practice analysis note, written before the run." >> "$F102"
  B102=$(analysis_sha "$F102"); S102=$(field "$F102" status); I101=$(inode "$F101")
  say ""; say "== Before: GTQ-102's record"
  say "status: $S102; analysis sha256 $B102 (a practice note added)"
  say ""; say "== The run"
  run node "$NORM" --jira "$W/jira/stories.json" --model "$W/model"; CODE=$?
  say "exit $CODE (2 = records written, some items not represented)"
  say ""; say "== After"
  A102=$(analysis_sha "$F102"); S102B=$(field "$F102" status)
  for k in GTQ-150 GTQ-151; do
    if [ -e "$W/model/items/jira__$k.md" ]; then say "$k: a record WAS written"; else say "$k: no record written"; fi
  done
  say "GTQ-102: status $S102B (before the run: $S102); analysis sha256 $A102"
  say "GTQ-102's record now begins:"
  sed -n '1,5p' "$F102" | tee -a "$REC"
  if [ "$(inode "$F101")" != "$I101" ]; then say "GTQ-101's record was rewritten by the run (a new file in its place)."; else say "GTQ-101's record was NOT rewritten."; fi
  say ""; say "== Not represented / not refreshed, from the index"
  sed -n '/^## Not represented/,$p' "$W/model/items/index.md" | tee -a "$REC"
  REAL_AFTER=$(folder_sha "$MODEL") || stop "Could not fingerprint the real model folder."
  JIRA_AFTER=$(folder_sha "$ROOT/participant/context/jira") || stop "Could not fingerprint the real Jira copy."
  say ""
  OK=1; WHY=""
  ufail() { OK=0; WHY="$WHY $1;"; }
  [ "$CODE" = 2 ] || ufail "the run exited $CODE, not 2"
  [ ! -e "$W/model/items/jira__GTQ-150.md" ] && [ ! -e "$W/model/items/jira__GTQ-151.md" ] || ufail "a record was written for GTQ-150 or GTQ-151"
  if is_hash "$B102"; then [ "$A102" = "$B102" ] || ufail "GTQ-102's analysis changed"; else ufail "GTQ-102's analysis couldn't be read before the run"; fi
  [ "$S102B" = "$S102" ] && [ "$S102B" != "Waiting for Customer" ] || ufail "GTQ-102's status changed"
  grep -q '^> \*\*Not refreshed:\*\* status "Waiting for Customer" isn.t in the Jira mapping' "$F102" || ufail "GTQ-102 isn't marked Not refreshed with the reason"
  grep -q '^| Jira GTQ-102 | status "Waiting for Customer" isn.t in the Jira mapping |$' "$W/model/items/index.md" || ufail "the index doesn't list GTQ-102 with its reason"
  grep -q '^| Jira GTQ-150 | status "Waiting for Customer" isn.t in the Jira mapping |$' "$W/model/items/index.md" || ufail "the index doesn't list GTQ-150 with its reason"
  grep -q '^| Jira GTQ-151 | required field missing or not allowed: title |$' "$W/model/items/index.md" || ufail "the index doesn't list GTQ-151 with its reason"
  [ "$(inode "$F101")" != "$I101" ] || ufail "GTQ-101's record wasn't rewritten"
  if [ "$REAL_BEFORE" = "$REAL_AFTER" ] && [ "$JIRA_BEFORE" = "$JIRA_AFTER" ]; then say "Check: the real model folder and the real Jira copy are unchanged (SHA-256 of every file in them, hidden ones included, before and after)."; else say "Check: the real model folder or Jira copy CHANGED."; ufail "a real folder changed"; fi
  if [ "$OK" = 1 ]; then
    say "Check: the run exited 2; the index lists GTQ-102, GTQ-150 and GTQ-151, each with its reason; GTQ-150 and GTQ-151 have no record; GTQ-102's earlier record is kept, its status unchanged, marked Not refreshed with the reason, its analysis byte-identical; GTQ-101's record was rewritten."
  else say "Check: FAILED:$WHY"; fi
  say "End of record."
  save "$OUTFILE" || exit 1
  echo "Saved: ${OUTFILE#"$ROOT"/}"
  [ "$OK" = 1 ]
  ;;

identity)
  OUTFILE="$ROOT/local-data/model-identity-first-half-stopped.txt"   # a stop here never replaces the evidence log
  [ ! -e "$STATE" ] || { echo "A run is already waiting for its second half (${STATE#"$ROOT"/})."; echo "Make the change and run the sync if you haven't, then: bash participant/tools/model-record.sh identity-after"; echo "(To start again instead: rm -f local-data/model-identity-state.json local-data/model-identity-partial.txt, then run node participant/tools/github-sync.mjs first (so the copy shows where the issue is now), then bash participant/tools/model-record.sh identity.)"; exit 1; }
  say "Identity across a rename and a move, $(stamp). Git commit $(commit), $(tree). Node $(node --version)."
  say "Tools (SHA-256, first 12): $(tools_line)"
  say "This script makes no external reads or writes; the GitHub change is made by hand, and GitHub is"
  say "read only by the GitHub quest's own synchronization, run separately."
  say ""
  say "== Part 1, Jira: a story renamed and moved to another status"
  say "The Jira quest's synchronization, against its pretend Jira (practice data, offline), into a"
  say "throwaway folder; the real Jira copy and model folder are checked unchanged below."
  REALJ_BEFORE=$(folder_sha "$ROOT/participant/context/jira") || stop "Could not fingerprint the real Jira copy."
  REALM_BEFORE=$(folder_sha "$MODEL") || stop "Could not fingerprint the real model folder."
  mkdir "$W/jira" || stop "Could not make the throwaway folder."
  say "-- sync, practice set stale-item"
  run env -u JIRA_SYNC_NOTES_LEDGER node "$ROOT/participant/tools/jira-sync.mjs" --fixture stale-item --out "$W/jira" || stop "The Jira sync failed; stopping."
  say "-- normalize"
  run node "$NORM" --jira "$W/jira/stories.json" --model "$W/jmodel" >/dev/null; C=$?
  [ "$C" = 0 ] || stop "Normalization exited $C; stopping. Its reason is in ${OUTFILE#"$ROOT"/}."
  J="$W/jmodel/items/jira__GTQ-101.md"
  [ -e "$J" ] || stop "GTQ-101 has no record; stopping."
  echo "Practice analysis note on GTQ-101." >> "$J"
  JA=$(analysis_sha "$J"); JT=$(field "$J" title); JS=$(field "$J" status); JN=$(ls "$W/jmodel/items" | grep -c '^jira__')
  say "GTQ-101, file items/jira__GTQ-101.md: id $(field "$J" id), title \"$JT\", status $JS; Jira records: $JN; analysis sha256 $JA (a practice note added)"
  say "-- sync, practice set happy-path (GTQ-101 renamed, and moved from To Do to In Progress)"
  run env -u JIRA_SYNC_NOTES_LEDGER node "$ROOT/participant/tools/jira-sync.mjs" --fixture happy-path --out "$W/jira" || stop "The Jira sync failed; stopping."
  say "-- normalize again"
  run node "$NORM" --jira "$W/jira/stories.json" --model "$W/jmodel" >/dev/null; C=$?
  JA2=$(analysis_sha "$J"); JN2=$(ls "$W/jmodel/items" | grep -c '^jira__')
  say "GTQ-101, file items/jira__GTQ-101.md: id $(field "$J" id), title \"$(field "$J" title)\", status $(field "$J" status); Jira records: $JN2; analysis sha256 $JA2"
  P1=1; WHY=""
  fails() { P1=0; WHY="$WHY $1;"; }
  [ "$C" = 0 ] || fails "normalization exited $C"
  [ "$(field "$J" id)" = "jira:GTQ-101" ] || fails "the file's id isn't jira:GTQ-101"
  [ "$JT" = "Fixture story GTQ-101" ] && [ "$JS" = "todo" ] || fails "the starting title or status isn't the expected one"
  [ "$(field "$J" title)" = "Capture the intake conversation" ] && [ "$(field "$J" status)" = "in_progress" ] || fails "the new title or status isn't the expected one"
  if is_hash "$JA"; then [ "$JA2" = "$JA" ] || fails "the analysis changed"; else fails "the analysis couldn't be read before the run"; fi
  [ "$(count_id "$W/jmodel/items" jira:GTQ-101)" = 1 ] || fails "not exactly one record has the id"
  [ -e "$W/jmodel/items/jira__GTQ-103.md" ] && [ "$JN2" = "$((JN + 1))" ] || fails "the second practice set's new story GTQ-103 isn't the one record added"
  [ "$(folder_sha "$ROOT/participant/context/jira")" = "$REALJ_BEFORE" ] && [ "$(folder_sha "$MODEL")" = "$REALM_BEFORE" ] || fails "the real Jira copy or model folder changed"
  [ "$P1" = 1 ] || stop "Check: Part 1 FAILED:$WHY stopping before Part 2."
  say "Check: the file jira__GTQ-101.md still holds id jira:GTQ-101; it went from \"Fixture story GTQ-101\", todo, to \"Capture the intake conversation\", in_progress; exactly one record has that id, and the one record added is GTQ-103's; the analysis is byte-identical; the real Jira copy and model folder are unchanged."

  say ""
  say "== Part 2, GitHub: a real issue renamed and moved to the other repository"
  say "-- normalize the real copies (the starting point)"
  run node "$NORM" >/dev/null; C=$?
  [ "$C" = 0 ] || stop "Normalization of the real copies exited $C; stopping. Its reason is in ${OUTFILE#"$ROOT"/}; if it names .normalize.lock and no normalization is running, remove that file and run this again."
  python3 -c '
import json, sys
g = json.load(open(sys.argv[1])); ident = json.load(open(sys.argv[2]))
open_ = [i for i in g["issues"].values() if i["state"] == "open"]
if len(open_) != 1: sys.exit("expected exactly one open assigned GitHub issue")
i = open_[0]
cid = [k for k, v in ident["items"].items() if k == "github:" + i["node_id"] or "github:" + i["node_id"] in v["aliases"]]
if len(cid) != 1: sys.exit("the issue has no single canonical record")
dest = [v.get("full_name", n) for n, v in g["repositories"].items() if v.get("readable") and v.get("full_name", n).lower() != i["repository"].lower()]
if len(dest) != 1: sys.exit("expected exactly one other readable repository")
new = "Print view for recipes and shopping lists (renamed for the identity check)"
if i["title"] == new: new = "Print view (renamed again for the identity check)"
json.dump({"cid": cid[0], "node": i["node_id"], "repo": i["repository"], "num": i["number"], "url": i["url"], "dest": dest[0], "newtitle": new, "sync_before": g["synchronized_at"], "aliases_before": ident["items"][cid[0]]["aliases"]}, open(sys.argv[3], "w"), indent=2)' "$GHSTATE" "$MODEL/identity.json" "$W/state.json" 2>"$W/why.txt" || { WHYTXT=$(tail -1 "$W/why.txt")
    case "$WHYTXT" in
      *"exactly one open"*) NEXT="This check needs exactly one open issue assigned to you: if there are more, unassign or close the others; if there are none, reopen the issue or assign it to yourself. Then run node participant/tools/github-sync.mjs, then this again." ;;
      *"readable repository"*) NEXT="Check that the token can read both practice repositories and that both are in the scope list, run node participant/tools/github-sync.mjs, then this again." ;;
      *) NEXT="Run node participant/tools/github-sync.mjs, then this again." ;;
    esac
    stop "Couldn't find the issue to move ($WHYTXT); stopping. $NEXT"; }
  get() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$W/state.json" "$1"; }
  CID=$(get cid); REPO=$(get repo); NUM=$(get num); DEST=$(get dest); NEWTITLE=$(get newtitle); URL=$(get url)
  F="$MODEL/items/${CID/:/__}.md"
  [ -e "$F" ] || stop "The issue's record wasn't found; stopping."
  say "The issue: $REPO#$NUM, record ${F#"$ROOT"/}, id $CID"
  B0=$(analysis_sha "$F")
  echo
  echo "Now write a note: open ${F#"$ROOT"/}, type something under \"## My analysis\","
  echo "SAVE the file, then press Return here."
  ask
  until has_note "$F" && [ "$(analysis_sha "$F")" != "$B0" ]; do
    echo "No new note found under \"## My analysis\" in that file (nothing changed there since this run"
    echo "started, or the line isn't there exactly once). Type the note in the editor, SAVE the file, then"
    echo "press Return here."
    ask
  done
  B=$(analysis_sha "$F"); BN=$(count_github)
  say "Before: file ${F#"$ROOT"/}: id $(field "$F" id), title \"$(field "$F" title)\", status $(field "$F" status), aliases $(field "$F" aliases); source $(field "$F" source_id); GitHub records: $BN; analysis sha256 $B (the note written for this run)"
  python3 -c '
import json, sys
s = json.load(open(sys.argv[1])); s.update(analysis_before=sys.argv[2], github_records_before=int(sys.argv[3]))
s["tools"] = sys.argv[5]
json.dump(s, open(sys.argv[4], "w"), indent=2)' "$W/state.json" "$B" "$BN" "$W/state-final.json" "$(tools_line)" || stop "Couldn't prepare the state for the second half."
  if ! BAD=$(token_free "$MODEL" "$W/state-final.json"); then
    case "$BAD" in unreadable:*) BADF=${BAD#unreadable: }; stop "A file can't be read (${BADF#"$ROOT"/}); fix its permissions, then run this again." ;;
      *) stop "A written file CONTAINS THE TOKEN (${BAD#"$ROOT"/}): remove the token from that file, don't commit, revoke the token on GitHub and make a new read-only one, then run this again." ;; esac
  fi
  say "-- waiting for the change, made by hand on GitHub's web page, and the GitHub quest's synchronization"
  save "$PARTIAL" || exit 1
  mv "$W/state-final.json" "$STATE" || { rm -f "$PARTIAL"; echo "Couldn't save the state; nothing is waiting. Run this again."; exit 1; }
  echo
  echo "Next, three steps:"
  echo "  1. On GitHub's web page, open $URL"
  echo "     Click Edit beside the title, change it to:  $NEWTITLE   and click Save."
  echo "  2. On the same page, in the right-hand column, click \"Transfer issue\", choose $DEST and"
  echo "     confirm. Do this once only. (It gets a new number and a new node ID there.)"
  echo "  3. In a terminal with the read-only token loaded, run the GitHub quest's synchronization:"
  echo "       node participant/tools/github-sync.mjs"
  echo "     If it says \"Incomplete\" (GitHub's search catching up), wait a minute and run it again."
  echo "Then run:  bash participant/tools/model-record.sh identity-after"
  ;;

identity-after)
  OUTFILE="$LOGS/identity-check.txt"
  ABANDON="To start again instead: rm -f local-data/model-identity-state.json local-data/model-identity-partial.txt, then run node participant/tools/github-sync.mjs first (so the copy shows where the issue is now), then bash participant/tools/model-record.sh identity (any change already made on GitHub stays)."
  if [ ! -e "$STATE" ] && [ ! -e "$PARTIAL" ]; then echo "Run the first half first: bash participant/tools/model-record.sh identity"; exit 1; fi
  if [ ! -e "$STATE" ] || [ ! -e "$PARTIAL" ]; then echo "Only half of the waiting run's files are there."; echo "$ABANDON"; exit 1; fi
  python3 -c '
import json, re, sys
s = json.load(open(sys.argv[1]))
ok = (isinstance(s.get("cid"), str) and re.fullmatch(r"github:[A-Za-z0-9_-]+", s["cid"])
      and all(isinstance(s.get(k), str) and s[k] for k in ("node", "repo", "dest", "newtitle", "sync_before"))
      and isinstance(s.get("num"), int) and isinstance(s.get("github_records_before"), int)
      and isinstance(s.get("aliases_before"), list) and isinstance(s.get("analysis_before"), str)
      and re.fullmatch(r"[0-9a-f]{64}", s["analysis_before"]))
sys.exit(0 if ok else 1)' "$STATE" 2>/dev/null || { echo "The waiting run's state can't be read."; echo "$ABANDON"; exit 1; }
  get() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$STATE" "$1"; }
  CID=$(get cid); NODE=$(get node); REPO=$(get repo); NUM=$(get num); DEST=$(get dest); NEWTITLE=$(get newtitle); B=$(get analysis_before); BN=$(get github_records_before)
  F="$MODEL/items/${CID/:/__}.md"
  [ -e "$F" ] || { echo "The record the waiting run is about (${F#"$ROOT"/}) isn't there."; echo "$ABANDON"; exit 1; }
  OUTFILE="$ROOT/local-data/model-identity-after-stopped.txt"   # until the checks pass, a stop never replaces the evidence log
  # The synchronization must have run since the first half, and seen the move.
  MOVED=$(python3 -c '
import json, sys
g = json.load(open(sys.argv[1])); s = json.load(open(sys.argv[2]))
if g.get("tool") != "github-sync" or g.get("schema") != 1: sys.exit("the GitHub copy was not written by the GitHub quest synchronization")
if g["synchronized_at"] <= s["sync_before"]: sys.exit("no GitHub synchronization has run since the first half")
nla = g.get("no_longer_assigned") or {}
gone = nla.get(s["node"])
if not isinstance(gone, dict):
    later = [e for e in nla.values() if isinstance(e, dict) and isinstance(e.get("last_known_record"), dict) and s["node"] in (e["last_known_record"].get("previous_node_ids") or [])]
    gone = later[0] if len(later) == 1 else None
if isinstance(gone, dict):
    reps = g.get("repositories") or {}
    ok = lambda name: any((v.get("full_name", n)).lower() == name.lower() and v.get("readable") for n, v in reps.items())
    print("GONE", gone.get("reason"), str(gone.get("detail") or "").replace("\t", " ").replace("\n", " ")[:200], "yes" if ok(s["dest"]) else "no", "yes" if ok(s["repo"]) else "no", sep="\t"); sys.exit(0)
same = [i for i in g["issues"].values() if i.get("node_id") == s["node"]]
if same: print("STILL", same[0].get("repository"), same[0].get("number"), g["synchronized_at"], sep="\t"); sys.exit(0)
hits = [i for i in g["issues"].values() if s["node"] in (i.get("previous_node_ids") or []) and i["node_id"] != s["node"]]
if len(hits) != 1: sys.exit("the synchronization does not show the issue moved yet (GitHub search may still be catching up; run it again)")
i = hits[0]
if i["repository"].lower() != s["dest"].lower(): print("WRONG", i["repository"], sep="\t"); sys.exit(0)
prev = i.get("previous_node_ids") or []
between = prev[prev.index(s["node"]) + 1:]
print(i["node_id"], i["repository"], i["number"], g["synchronized_at"], ",".join(between), sep="\t")' "$GHSTATE" "$STATE") || { echo "Not yet: run the GitHub quest's synchronization (node participant/tools/github-sync.mjs) after the change, then this again."; exit 1; }
  case "$MOVED" in STILL*) echo "The synchronization of $(showtime "$(printf '%s' "$MOVED" | cut -f4)") shows the issue still at $(printf '%s' "$MOVED" | cut -f2)#$(printf '%s' "$MOVED" | cut -f3), not yet transferred."; echo "If you transferred it after that synchronization, just run node participant/tools/github-sync.mjs again, then this."; echo "If not, do step 2 (Transfer issue, to $DEST) once, run the synchronization, then this again."; exit 1 ;; esac
  case "$MOVED" in GONE*) echo "The synchronization shows the issue no longer assigned to you ($(printf '%s' "$MOVED" | cut -f2): $(printf '%s' "$MOVED" | cut -f3); any time in that text is the GitHub synchronization's own, in its computer's local time)."
    if [ "$(printf '%s' "$MOVED" | cut -f2)" = "inaccessible" ] && [ "$(printf '%s' "$MOVED" | cut -f5)" = "yes" ]; then
      echo "GitHub answered for $REPO, but not for the issue at its old address (see its text above): it may have been deleted, or its number reused."
      echo "If it was deleted, it can't be moved any more: start again with another issue assigned to you. $ABANDON"; exit 1
    fi
    case "$(printf '%s' "$MOVED" | cut -f2)" in inaccessible|"out of scope")
      echo "The synchronization couldn't read $REPO (or it's out of scope), so it couldn't follow the move. Give the token access to $REPO again (and keep it in the scope list), run node participant/tools/github-sync.mjs, then this again; or: $ABANDON"; exit 1 ;; esac
    if [ "$(printf '%s' "$MOVED" | cut -f4)" = "no" ] || [ "$(printf '%s' "$MOVED" | cut -f5)" = "no" ]; then echo "The synchronization couldn't read $DEST or $REPO: check the token's access to that repository, run the synchronization again, then this; or: $ABANDON"; exit 1; fi
    echo "On GitHub, make it open, assigned to you and in $DEST, run the synchronization again, then this; or: $ABANDON"; exit 1 ;; esac
  case "$MOVED" in WRONG*) echo "The synchronization shows the issue in $(printf '%s' "$MOVED" | cut -f2), not $DEST."; echo "Transfer it on to $DEST by hand and run the synchronization again, then this; or: $ABANDON"; exit 1 ;; esac
  NEWNODE=$(printf '%s' "$MOVED" | cut -f1); NEWREPO=$(printf '%s' "$MOVED" | cut -f2); NEWNUM=$(printf '%s' "$MOVED" | cut -f3); SYNCAT=$(printf '%s' "$MOVED" | cut -f4); BETWEEN=$(printf '%s' "$MOVED" | cut -f5)
  TOOLS_THEN=$(get tools 2>/dev/null)
  if [ "$TOOLS_THEN" != "$(tools_line)" ]; then echo "The tools changed since the first half (their fingerprints differ), so one record can't describe both halves."; echo "$ABANDON"; exit 1; fi
  cp "$PARTIAL" "$REC" || exit 1
  say "-- second half, $(stamp). Git commit $(commit), $(tree). Tools (SHA-256, first 12), unchanged since the first half: $(tools_line)"
  say "Tom was asked to rename $REPO#$NUM to \"$NEWTITLE\" and transfer it to $DEST, by hand on GitHub's web page."
  SYNCSHOWN=$(showtime "$SYNCAT")
  say "A GitHub synchronization newer than the first half (written by the GitHub quest's synchronization, its run of $SYNCSHOWN) records the move:"
  say "now $NEWREPO#$NEWNUM, node ID $NEWNODE, with $NODE among its previous node IDs."
  [ -z "$BETWEEN" ] || say "It also passed through node ID(s) $BETWEEN on the way (more than one transfer), recorded by the synchronization."
  has_note "$F" || stop "The record has no readable note under exactly one \"## My analysis\" line now; stopping (the waiting run is kept). Put the line and a note back in ${F#"$ROOT"/}, then run identity-after again."
  B2=$(analysis_sha "$F")
  is_hash "$B2" || stop "The record's analysis can't be read; stopping (the waiting run is kept)."
  [ "$B2" = "$B" ] || say "(The note was edited after the first half; the check below uses the note as it is now, $B2.)"
  say "-- normalize again"
  run node "$NORM"; NC=$?
  A=$(analysis_sha "$F"); AN=$(count_github)
  AALIAS=$(field "$F" aliases)
  say ""
  say "After: file ${F#"$ROOT"/}: id $(field "$F" id), title \"$(field "$F" title)\", status $(field "$F" status), aliases $AALIAS; source $(field "$F" source_id); GitHub records: $AN; analysis sha256 $A"
  P2=1; WHY=""
  fails() { P2=0; WHY="$WHY $1;"; }
  [ "$NC" = 0 ] || fails "normalization exited $NC"
  [ "$(field "$F" id)" = "$CID" ] || fails "the file's id isn't $CID"
  [ "$(field "$F" title)" = "$NEWTITLE" ] || fails "the title isn't the new one"
  [ "$A" = "$B2" ] || fails "the analysis changed"
  [ "$AN" = "$BN" ] || fails "the GitHub record count changed"
  [ "$(count_id "$MODEL/items" "$CID")" = 1 ] || fails "not exactly one record has the id"
  python3 -c '
import json, re, sys
s = json.load(open(sys.argv[1])); after = set(re.findall(r"github:[A-Za-z0-9_-]+", sys.argv[2]))
before = set(s["aliases_before"]) | {s["cid"]}
expected = {"github:" + sys.argv[3]} | {"github:" + b for b in sys.argv[4].split(",") if b}
sys.exit(0 if after - before == expected and set(s["aliases_before"]) <= after else 1)' "$STATE" "$AALIAS" "$NEWNODE" "$BETWEEN" || fails "the aliases didn't gain exactly the node ID(s) of this move"
  case "$(field "$F" source_id)" in "$NEWREPO#$NEWNUM (node ID $NEWNODE)") ;; *) fails "the address isn't the new one" ;; esac
  if [ -n "${GTQ_GITHUB_TOKEN:-}" ]; then
    if BAD=$(token_free "$ROOT/participant/context/github/assigned" "$MODEL"); then say "Check: no file in the GitHub copy or the model folder contains the token."
    else
      case "$BAD" in unreadable:*) BADF=${BAD#unreadable: }; say "Check: FAILED, a file can't be read: ${BADF#"$ROOT"/}"; fails "a file can't be read (fix its permissions)" ;;
        *) say "Check: FAILED, a file CONTAINS THE TOKEN: ${BAD#"$ROOT"/}"; fails "the token is in a file" ;; esac
    fi
  else say "(The token isn't loaded in this terminal, so the token check of the written files was skipped here.)"; fi
  if [ "$B2" = "$B" ]; then NOTEWORDS="the analysis note is byte-identical to the note saved before the change"; else NOTEWORDS="the analysis note is byte-identical to the note as it was at the start of this second half (it was edited between the halves)"; fi
  if [ "$P2" = 1 ]; then
    say "Check: the same file still holds id $CID; it took the new title and the new address ($DEST#$NEWNUM, node ID $NEWNODE); exactly the node ID(s) of this move were added to its aliases; exactly one record has that id and the GitHub record count is unchanged ($AN); $NOTEWORDS."
  else say "Check: Part 2 FAILED:$WHY"; fi
  say "End of record."
  if [ "$P2" = 1 ]; then OUTFILE="$LOGS/identity-check.txt"; fi
  save "$OUTFILE" || exit 1
  echo "Saved: ${OUTFILE#"$ROOT"/}"
  if [ "$P2" != 1 ] && [ "$NC" != 0 ]; then
    echo "The waiting run is kept. Normalization exited $NC, so the checks after it couldn't pass either."
    if [ "$NC" = 2 ]; then echo "Its \"Not represented\" / \"Not refreshed\" lines (above, and in ${OUTFILE#"$ROOT"/}) say which item was refused and why."; echo "If the reason is that a file changed while the run was working, just run this again. Otherwise fix that on GitHub, run the GitHub quest's synchronization, then this again; or: $ABANDON"
    else echo "Its message (above) says why; if it names .normalize.lock and no normalization is running, remove that file and run this again."; fi
  elif [ "$P2" != 1 ]; then
    echo "The waiting run is kept. What to do depends on what failed (above):"
    echo "  - the token is in a file: remove the token from that file, don't commit, revoke the token on GitHub and make a new read-only one, then run this again;"
    echo "  - a file can't be read: fix its permissions, then run this again;"
    echo "  - the title isn't the new one: fix the title on GitHub, run the GitHub quest's synchronization, then this again;"
    echo "  - the GitHub record count changed (another issue was assigned meanwhile): that can't be undone here: $ABANDON"
    echo "  - anything else: $ABANDON"
  fi
  if [ "$P2" = 1 ]; then rm -f "$STATE" "$PARTIAL" "$ROOT/local-data/model-identity-after-stopped.txt" "$ROOT/local-data/model-identity-first-half-stopped.txt"; fi
  [ "$P2" = 1 ]
  ;;
esac
