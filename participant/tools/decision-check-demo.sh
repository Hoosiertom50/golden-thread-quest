#!/bin/bash
# Demonstrates the decision-log checker (participant/tools/decision-check.mjs) for the
# context-decision-log quest: it checks the real log, then copies of it broken on purpose, one
# mistake each, and a correct promotion checked against the earlier copy. Every broken case must
# fail exactly the checks named for it, with the expected message, and pass every other check. The
# copies live in a new temp folder that is deleted afterwards; the real files are only read.
#
#   bash participant/tools/decision-check-demo.sh <logs folder>   (from the repository's top folder)
#
# Writes log-check.txt into <logs folder> only if every case came out as expected (an existing
# log-check.txt is replaced only if it is an ordinary file). The log ends with the full text of
# sources.md and the checker's SHA-256, so a reader of the log alone can verify every approval.
# Exit codes: 0 all as expected, 1 something unexpected (nothing written), 2 setup error.
set -u -o pipefail
REPO=$(cd -P . && printf '%s/.' "$PWD") || exit 2
REPO=${REPO%/.}
CHECK="$REPO/participant/tools/decision-check.mjs"
REAL="$REPO/participant/context/decisions"
[ -f "$CHECK" ] && [ -f "$REAL/log.md" ] && [ -f "$REAL/rules.md" ] && [ -f "$REAL/sources.md" ] || { echo "Run this from the repository's top folder."; exit 2; }
[ $# -eq 1 ] || { echo "Usage: bash participant/tools/decision-check-demo.sh <logs folder>"; exit 2; }
mkdir -p "$1" || exit 2
LOGS=$(cd -P -- "$1" && printf '%s/.' "$PWD") || exit 2
LOGS=${LOGS%/.}
if [ -L "$LOGS/log-check.txt" ] || { [ -e "$LOGS/log-check.txt" ] && [ ! -f "$LOGS/log-check.txt" ]; }; then
  echo "log-check.txt in the logs folder is not an ordinary file; stopping."; exit 2
fi

# The temp folder: new, checked before anything is ever deleted from it.
T=$(mktemp -d "${TMPDIR:-/tmp}/decision-check-demo.XXXXXX") || exit 2
[ -n "$T" ] && [ -d "$T" ] && [ ! -L "$T" ] || { echo "Couldn't make the temp folder."; exit 2; }
T=$(cd -P -- "$T" && printf '%s/.' "$PWD") || exit 2
T=${T%/.}
case "$(basename "$T")" in
  decision-check-demo.??????) ;;
  *) echo "Unexpected temp folder; stopping."; exit 2 ;;
esac
[ -z "$(ls -A "$T")" ] || { echo "The temp folder isn't new; stopping."; exit 2; }
cleanup() { rm -rf -- "$T"; }
FAIL=0
OUT="$T/log-check.txt"
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
fingerprint() { printf '%s %s %s' "$(sha "$REAL/log.md")" "$(sha "$REAL/rules.md")" "$(sha "$REAL/sources.md")"; }
BEFORE=$(fingerprint)

# copy <name>: a fresh copy of the real files, as $T/<name>
copy() { mkdir "$T/$1" && cp "$REAL/log.md" "$REAL/rules.md" "$REAL/sources.md" "$T/$1/"; }
# edit <name> <file> <text> <replacement>: replaces text that must appear exactly once
edit() {
  node -e '
    const fs = require("fs"), [file, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(file, "utf8"), n = s.split(from).length - 1;
    if (n !== 1) { console.error(`edit: expected the text once, found it ${n} times`); process.exit(1); }
    fs.writeFileSync(file, s.replace(from, () => to));
  ' "$T/$1/$2" "$3" "$4" || FAIL=1
}
# view <name>: sets the copy's Current decisions list to what its entries call for (so a case
# fails only for its own mistake, not also for a stale list)
view() {
  local v
  v=$(cd "$T" && node "$CHECK" --dir "$T/$1" --print-view) || { FAIL=1; return; }
  node -e '
    const fs = require("fs"), [file, view] = process.argv.slice(1);
    const s = fs.readFileSync(file, "utf8");
    const a = "<!-- current-decisions: start -->", b = "<!-- current-decisions: end -->";
    fs.writeFileSync(file, s.slice(0, s.indexOf(a) + a.length) + "\n" + view + "\n" + s.slice(s.indexOf(b)));
  ' "$T/$1/log.md" "$v" || FAIL=1
}
# changes <name>: the lines changed from the real files, without file names
changes() {
  echo "What was changed in this copy:"
  for f in log.md rules.md sources.md; do
    diff "$REAL/$f" "$T/$1/$f" | grep -E '^[<>] .*[^ ]' | grep -v -E '^[<>] \| (D-|Decision|---)' | sed -e "s/^</  $f, before:/" -e "s/^>/  $f, after: /"
  done
}
# run <name> "<failing checks>" "<expected message>" [extra arguments...]: runs the checker on a
# copy; exactly the named checks (space-separated, e.g. "2" or "1 History") must fail, the message
# must appear, and the exit code must be 1 (or 0 when no check is named).
run() {
  local name=$1 want=$2 msg=$3 code out failing
  shift 3
  echo "\$ node decision-check.mjs --dir $name$( [ $# -gt 0 ] && printf ' %s' "$@")"
  out=$(cd "$T" && node "$CHECK" --dir "$T/$name" "$@" 2>&1)
  code=$?
  printf '%s\n' "${out//"$T/"/}"
  echo "exit code: $code"
  failing=$(printf '%s\n' "$out" | sed -n -E 's/^FAIL  ([0-9]+|[A-Za-z]+)[.:].*/\1/p' | tr '\n' ' ' | sed 's/ $//')
  if [ "$failing" != "$want" ]; then echo "UNEXPECTED: checks failing were \"$failing\", expected \"$want\""; FAIL=1; fi
  if [ -n "$msg" ] && ! printf '%s\n' "$out" | grep -qF -- "$msg"; then echo "UNEXPECTED: the message \"$msg\" is missing"; FAIL=1; fi
  if [ -z "$want" ] && [ "$code" != 0 ]; then echo "UNEXPECTED: exit code 0 was expected"; FAIL=1; fi
  if [ -n "$want" ] && [ "$code" != 1 ]; then echo "UNEXPECTED: exit code 1 was expected"; FAIL=1; fi
  [ -n "$want" ] && echo "As expected: only check(s) $want failed, with \"$msg\"." || echo "As expected: every check passed."
  echo
}

{
  echo "context-decision-log: the decision-log check"
  echo "Recorded $(date '+%m-%d-%Y %I:%M %p') with Node $(node --version), by participant/tools/decision-check-demo.sh."
  echo "Each case is a copy of the real files (participant/context/decisions/) in a temp folder, changed"
  echo "as shown, with its Current decisions list rebuilt so that only the case's own mistake can fail."
  echo "The real files are only read. Folder names below are relative to that temp folder."
  echo

  echo "== 1. The real log =="
  echo "\$ node participant/tools/decision-check.mjs"
  out=$(cd "$REPO" && node "$CHECK" 2>&1); code=$?
  printf '%s\nexit code: %s\n\n' "$out" "$code"
  [ "$code" = 0 ] || { echo "UNEXPECTED: exit code 0 was expected"; FAIL=1; }

  echo "== 2. Agreement recorded as an approval (the quest's scenario) =="
  echo "P-03 is promoted to a decision whose approval quotes the meeting's agreement, not an approval."
  copy agreement
  edit agreement log.md "- Proposed by: Jordan Pike
- Note: everyone in MTG-02" "- Proposed by: Jordan Pike
- Became: D-08
- Note: everyone in MTG-02"
  printf '\n### D-08 · Waive the service fee for orders of 6 or more tickets\n\n- Status: decision\n- Date: 10-19-2026\n- Source: MTG-02\n- Area: fees\n- Approver: Avery Lane\n- Approval: "Jordan: we could waive the fee for orders of 6 or more tickets. Everyone agreed it was a good idea."\n- From: P-03\n- Affects: none\n' >> "$T/agreement/log.md"
  view agreement; changes agreement
  run agreement "2" "agreement is not an approval"

  echo "== 3. A decision with no approver =="
  copy no-approver
  edit no-approver log.md "- Area: pages
- Approver: Avery Lane
- Approval: \"Approved by Avery Lane: the buyer's name" "- Area: pages
- Approval: \"Approved by Avery Lane: the buyer's name"
  view no-approver; changes no-approver
  run no-approver "1 2" "no approver is recorded"

  echo "== 4. An approval quote that isn't in its source, word for word =="
  copy wrong-quote
  edit wrong-quote log.md "\"Approved by Avery Lane: the service fee is \$2.50 per ticket, charged on every ticket.\"" "\"Approved by Avery Lane: the service fee is \$2.00 per ticket, charged on every ticket.\""
  view wrong-quote; changes wrong-quote
  run wrong-quote "2" "the approval line isn't in MTG-01, word for word"

  echo "== 5. An approver outside their authority =="
  echo "Sam Ortiz may approve only 'calculation'; D-04's area is changed to 'fees'."
  copy no-authority
  edit no-authority log.md "- Area: calculation" "- Area: fees"
  view no-authority; changes no-authority
  run no-authority "2" "Sam Ortiz may not approve area \"fees\""

  echo "== 6. A decision borrowing another decision's approval =="
  echo "A new D-08 says the fee is waived, citing D-01's approval of the \$2.50 fee."
  copy borrowed
  printf '\n### D-08 · The service fee is waived for everyone\n\n- Status: decision\n- Date: 11-10-2026\n- Source: MTG-01\n- Area: fees\n- Approver: Avery Lane\n- Approval: "Approved by Avery Lane: the service fee is $2.50 per ticket, charged on every ticket."\n- Affects: none\n' >> "$T/borrowed/log.md"
  view borrowed; changes borrowed
  run borrowed "2" "uses the same approval as D-01"

  echo "== 7. Work resting on a proposal (a proposal treated as decided) =="
  copy work-on-proposal
  edit work-on-proposal sources.md "| SHOP-17 | Cancel an order from the orders page | D-05 |" "| SHOP-17 | Cancel an order from the orders page | D-05 |
| SHOP-18 | Waive the fee for 6+ tickets at checkout | P-03 |"
  changes work-on-proposal
  run work-on-proposal "3" "work item SHOP-18 rests on P-03, a proposal"

  echo "== 8. A correct promotion, checked against the earlier copy =="
  echo "Avery Lane approves P-01 in a new meeting: a new decision D-08 is added at the end"
  echo "(From: P-01), and P-01 gets one added line (Became: D-08)."
  copy promotion
  cp "$REAL/log.md" "$T/earlier-log.md"
  edit promotion sources.md "## DOC-01 ·" "## MTG-04 · Seating follow-up, 11-16-2026

Attendees: Avery Lane, Jordan Pike.

- Approved by Avery Lane: buyers may choose their seats on a seating map.

## DOC-01 ·"
  edit promotion log.md "- Proposed by: Jordan Pike

### Q-01 ·" "- Proposed by: Jordan Pike
- Became: D-08

### Q-01 ·"
  printf '\n### D-08 · Buyers may choose their seats on a seating map\n\n- Status: decision\n- Date: 11-16-2026\n- Source: MTG-04\n- Area: pages\n- Approver: Avery Lane\n- Approval: "Approved by Avery Lane: buyers may choose their seats on a seating map."\n- From: P-01\n- Affects: none\n' >> "$T/promotion/log.md"
  view promotion; changes promotion
  run promotion "" "" --previous earlier-log.md

  echo "== 9. A status changed by rewriting the earlier entry =="
  echo "Instead, P-01 is edited in place into a decision: its earlier wording is lost."
  copy rewrite
  cp "$T/promotion/sources.md" "$T/rewrite/sources.md"
  edit rewrite log.md "### P-01 · Let buyers choose their seats on a seating map

- Status: proposal
- Date: 10-12-2026
- Source: DOC-01
- Proposed by: Jordan Pike" "### P-01 · Let buyers choose their seats on a seating map

- Status: decision
- Date: 11-16-2026
- Source: MTG-04
- Area: pages
- Approver: Avery Lane
- Approval: \"Approved by Avery Lane: buyers may choose their seats on a seating map.\"
- Affects: none"
  view rewrite; changes rewrite
  run rewrite "1 History" "\"Status: decision\" was added or changed" --previous earlier-log.md

  echo "== 10. A replaced decision that no longer links to its replacement =="
  copy one-way
  edit one-way log.md "- Affects: SHOP-13
- Replaced by: D-07" "- Affects: SHOP-13"
  view one-way; changes one-way
  run one-way "5 Stretch" "D-02 doesn't say \"Replaced by: D-07\""

  echo "== 11. A decision that replaces itself =="
  copy self-replace
  edit self-replace log.md "- Source: SUP-04" "- Source: SUP-04
- Replaces: D-06
- Replaced by: D-06"
  view self-replace; changes self-replace
  run self-replace "5" "must come after D-06, which it replaces"

  echo "== 12. A source that doesn't exist, and a date that isn't one =="
  copy no-source
  edit no-source log.md "- Source: SUP-04" "- Source: SUP-99"
  edit no-source log.md "- Date: 10-26-2026" "- Date: 13-26-2026"
  view no-source; changes no-source
  run no-source "6" "source SUP-99 isn't in sources.md"

  echo "== 13. A Current decisions view edited by hand =="
  copy stale-view
  edit stale-view log.md "| D-01 | the service fee is \$2.50 per ticket" "| D-01 | the service fee is \$2.00 per ticket"
  changes stale-view
  run stale-view "7" "the Current decisions view doesn't match the entries"

  echo "== 14. --write-view refuses to write over a log with a problem =="
  echo "The copy from case 6 (a borrowed approval), with its list emptied, is given --write-view."
  copy refuse-write
  cp "$T/borrowed/log.md" "$T/refuse-write/log.md"
  node -e '
    const fs = require("fs"), f = process.argv[1], s = fs.readFileSync(f, "utf8");
    const a = "<!-- current-decisions: start -->", b = "<!-- current-decisions: end -->";
    fs.writeFileSync(f, s.slice(0, s.indexOf(a) + a.length) + "\n" + s.slice(s.indexOf(b)));
  ' "$T/refuse-write/log.md"
  cp "$T/refuse-write/log.md" "$T/refuse-write-before.md"
  run refuse-write "2" "was NOT written" --write-view
  if cmp -s "$T/refuse-write-before.md" "$T/refuse-write/log.md"; then echo "The copy's log.md is unchanged, byte for byte."; else echo "UNEXPECTED: the log was written"; FAIL=1; fi
  echo

  AFTER=$(fingerprint)
  echo "== The real files were only read =="
  echo "SHA-256 of log.md, rules.md and sources.md, before: $BEFORE"
  echo "and after:                                         $AFTER"
  if [ "$BEFORE" = "$AFTER" ]; then echo "identical"; else echo "THE REAL FILES CHANGED"; FAIL=1; fi
  echo
  echo "== For the reader of this log alone: what was checked against =="
  echo "SHA-256 of participant/tools/decision-check.mjs: $(sha "$CHECK")"
  echo "SHA-256 of participant/context/decisions/sources.md: $(sha "$REAL/sources.md")"
  echo "The full text of participant/context/decisions/sources.md, the written records every approval"
  echo "above is checked against:"
  echo "----- sources.md -----"
  cat "$REAL/sources.md"
  echo "----- end of sources.md -----"
} > "$OUT" 2>&1

if grep -qF -- "$T" "$OUT"; then echo "The log contains the temp folder's real name; nothing is written."; FAIL=1; fi
if [ "$FAIL" != 0 ]; then
  echo "Something unexpected happened; nothing was written. The log:"
  cat "$OUT"
  cleanup
  exit 1
fi
node -e '
  const fs = require("fs"), [src, dir] = process.argv.slice(1);
  const tmp = `${dir}/.log-check.txt.${process.pid}.new`;
  fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
  try { fs.renameSync(tmp, `${dir}/log-check.txt`); } catch (e) { fs.unlinkSync(tmp); throw e; }
' "$OUT" "$LOGS" || { echo "Couldn't put log-check.txt in place."; cleanup; exit 2; }
cleanup
echo "Written: log-check.txt"
