#!/usr/bin/env bash
# The open-questions check, recorded: the real file must pass, and eight broken copies, each with
# one planted mistake, must each fail for the reason planted. Copies live in one throwaway folder;
# the real files are only read.
#
#   bash participant/tools/open-question-check-demo.sh <logs folder>
#
# Writes <logs folder>/question-check.txt. Exit 0 only if every case came out as expected.

set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOGDIR=${1:?usage: open-question-check-demo.sh <logs folder>}
mkdir -p "$LOGDIR" || exit 1
CHECK="$ROOT/participant/tools/check-open-questions.py"
REAL="$ROOT/participant/context/transcripts/sample-meeting.open-questions.md"
W=$(mktemp -d "${TMPDIR:-/tmp}/open-question-check.XXXXXX") || { echo "Could not make a temporary folder."; exit 1; }
trap 'rm -rf -- "${W:?}"' EXIT
REC="$W/record.txt"
OK=0
BAD=0
say() { printf '%s\n' "$*" >> "$REC"; }

say "The open-questions check, $(date '+%m-%d-%Y %-I:%M %p %Z'). Git commit $(git -C "$ROOT" rev-parse --short HEAD); $(python3 --version)."
say ""
say "== The real file"
python3 "$CHECK" >> "$REC" 2>&1
CODE=$?
if [ "$CODE" = 0 ]; then OK=$((OK + 1)); say "as expected: passed (exit 0)"; else BAD=$((BAD + 1)); say "UNEXPECTED: exit $CODE"; fi

# case name, what is planted, the reason the check must give, then a python edit of the copy
broken() {
  local name=$1 what=$2 reason=$3 edit=$4 out code
  cp "$REAL" "$W/$name.md"
  python3 -c "import sys; p=sys.argv[1]; s=open(p).read(); $edit; open(p,'w').write(s)" "$W/$name.md"
  if cmp -s "$REAL" "$W/$name.md"; then BAD=$((BAD + 1)); say ""; say "== $name: UNEXPECTED: the edit didn't change the copy"; return; fi
  out=$(python3 "$CHECK" --questions "$W/$name.md" 2>&1)
  code=$?
  say ""
  say "== Broken copy: $name ($what)"
  printf '%s\n' "$out" | sed -n '/^FAILED/,$p' >> "$REC"
  if [ "$code" = 1 ] && printf '%s' "$out" | grep -qF -- "$reason"; then OK=$((OK + 1)); say "as expected: failed, naming it (\"$reason\")"
  else BAD=$((BAD + 1)); say "UNEXPECTED: exit $code, or the reason \"$reason\" not given"; fi
}

broken answered-listed-open "C1, answered at U004 \"Yes, both.\", moved into the open list" "reads like an answer" \
  "s=s.replace('### C1 · Does the dropdown stay?\n\n- Raised: U003 \"The dropdown stays, though, right?\"\n- Answered: U004 \"Yes, both. Drag is an extra, not a replacement.\"\n\n',''); s=s.replace('## Closed in the meeting','### Q5 · Does the dropdown stay?\n\n- Raised: U003 \"The dropdown stays, though, right?\"\n- Raised by: Marcus Lee (U003)\n- Kept open by: U003 \"For keyboard users.\"\n- Owner: not stated\n- Due: not stated\n- Why open: nobody confirmed it.\n\n## Closed in the meeting'); s=s.replace('- Open questions: 4','- Open questions: 5').replace('- Closed in the meeting: 9','- Closed in the meeting: 8')"
broken guessed-owner "Q3's owner guessed as Marcus Lee, citing a line he neither said nor is named in" "neither the speaker of U035 nor named in it" \
  "i=s.index('### Q3'); j=s.index('- Owner: not stated', i); s=s[:j]+'- Owner: Marcus Lee, U035 \"whether we need a drag hint for first-time users\"'+s[j+len('- Owner: not stated'):]"
broken missing-id "Q4 cites U099, which doesn't exist" "U099, which isn't in the transcript" \
  "s=s.replace('- Kept open by: U037 \"Good, add it.\"','- Kept open by: U099 \"Good, add it.\"')"
broken changed-quote "C5's quote changed by one word" "isn't word for word in U016" \
  "s=s.replace('U016 \"Locked tables refuse drops.\"','U016 \"Locked tables accept drops.\"')"
broken question-left-out "C7 (U030, the printing question) deleted" "U030 asks a question" \
  "i=s.index('### C7'); j=s.index('### C8'); s=s[:i]+s[j:]; s=s.replace('- Closed in the meeting: 9','- Closed in the meeting: 8')"
broken answer-before-question "C3 answered by U008, before the question at U009" "doesn't come after the question U009" \
  "s=s.replace('- Answered: U011 \"A message, please. Shaking alone isn\\'t clear enough.\"','- Answered: U008 \"That\\'s doable.\"')"
broken decisions-mixed-in "a Decisions section added to the questions file" "isn't allowed here" \
  "s=s.replace('## Not counted','## Decisions\n\n- D1 drag to assign\n\n## Not counted')"
broken wrong-count "the open count says 3" "says 3, the list has 4" \
  "s=s.replace('- Open questions: 4','- Open questions: 3')"

say ""
say "$OK cases as expected, $BAD unexpected."
say "End of record."
ROOT="$ROOT" W="$W" python3 -c '
import os, sys
t = open(sys.argv[1]).read().replace(os.environ["W"], "<temp>").replace(os.environ["ROOT"], "<repo>").replace(os.path.expanduser("~"), "~")
tmp = os.path.join(os.path.dirname(sys.argv[2]), "." + os.path.basename(sys.argv[2]) + ".new")
with open(tmp, "x") as f: f.write(t)
os.replace(tmp, sys.argv[2])
' "$REC" "$LOGDIR/question-check.txt" || { echo "The record could not be saved."; exit 1; }
cat "$LOGDIR/question-check.txt"
[ "$BAD" -eq 0 ]
