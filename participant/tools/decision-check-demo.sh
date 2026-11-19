#!/bin/bash
# Demonstrates the decision-log checker (participant/tools/decision-check.mjs) for the
# context-decision-log quest: it checks the real log, then copies of it broken on purpose, one
# mistake each, and a correct promotion checked against the earlier copy. The copies live in a new
# temp folder that is deleted afterwards; the real log is only read.
#
#   bash participant/tools/decision-check-demo.sh <logs folder>   (from the repository's top folder)
#
# Writes log-check.txt into <logs folder>, only if every result came out as expected (an existing
# log-check.txt is replaced only if it is an ordinary file). Exit codes: 0 all as expected,
# 1 something unexpected (nothing written), 2 setup error.
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
BEFORE=$(cd "$REAL" && cat log.md rules.md sources.md | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(d).digest("hex")))')

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
# changes <name>: the lines changed from the real files, without file names
changes() {
  echo "What was changed in this copy:"
  for f in log.md rules.md sources.md; do
    diff "$REAL/$f" "$T/$1/$f" | grep -E '^[<>] .*[^ ]' | sed -e "s/^</  $f, before:/" -e "s/^>/  $f, after: /"
  done
}
# run <expected exit code> <name> [extra arguments...]: runs the checker on a copy
run() {
  local want=$1 name=$2 code out
  shift 2
  echo "\$ node decision-check.mjs --dir $name$( [ $# -gt 0 ] && printf ' %s' "$@")"
  out=$(cd "$T" && node "$CHECK" --dir "$T/$name" "$@" 2>&1)
  code=$?
  printf '%s\n' "${out//"$T/"/}"
  echo "exit code: $code"
  if [ "$code" != "$want" ]; then echo "UNEXPECTED: exit code $want was expected"; FAIL=1; fi
  echo
}

{
  echo "context-decision-log: the decision-log check"
  echo "Recorded $(date '+%m-%d-%Y %I:%M %p') with Node $(node --version), by participant/tools/decision-check-demo.sh."
  echo "Each case is a copy of the real files (participant/context/decisions/) in a temp folder, changed"
  echo "as shown; the real files are only read. Folder names below are relative to that temp folder."
  echo

  echo "== 1. The real log =="
  echo "\$ node participant/tools/decision-check.mjs"
  out=$(cd "$REPO" && node "$CHECK" 2>&1); code=$?
  printf '%s\nexit code: %s\n\n' "$out" "$code"
  [ "$code" = 0 ] || { echo "UNEXPECTED: exit code 0 was expected"; FAIL=1; }

  echo "== 2. Agreement recorded as an approval (the quest's scenario) =="
  echo "P-03 is turned into a decision whose approval quotes the meeting's agreement, not an approval."
  copy agreement
  edit agreement log.md "- Proposed by: Jordan Pike
- Note: everyone in MTG-02" "- Proposed by: Jordan Pike
- Became: D-08
- Note: everyone in MTG-02"
  edit agreement log.md "### Q-03 ·" "### D-08 · Waive the service fee for orders of 6 or more tickets

- Status: decision
- Date: 10-19-2026
- Source: MTG-02
- Area: fees
- Approver: Avery Lane
- Approval: \"Jordan: we could waive the fee for orders of 6 or more tickets. Everyone agreed it was a good idea.\"
- From: P-03
- Affects: none

### Q-03 ·"
  (cd "$T" && node "$CHECK" --dir "$T/agreement" --write-view > /dev/null)
  changes agreement
  run 1 agreement

  echo "== 3. A decision with no approver =="
  copy no-approver
  edit no-approver log.md "- Area: pages
- Approver: Avery Lane
- Approval: \"Approved by Avery Lane: the buyer's name" "- Area: pages
- Approval: \"Approved by Avery Lane: the buyer's name"
  changes no-approver
  run 1 no-approver

  echo "== 4. An approval quote that isn't in its source, word for word =="
  copy wrong-quote
  edit wrong-quote log.md "\"Approved by Avery Lane: the service fee is \$2.50 per ticket, charged on every ticket.\"" "\"Approved by Avery Lane: the service fee is \$2.00 per ticket, charged on every ticket.\""
  changes wrong-quote
  run 1 wrong-quote

  echo "== 5. An approver outside their authority =="
  echo "Sam Ortiz may approve only 'calculation'; D-04's area is changed to 'fees'."
  copy no-authority
  edit no-authority log.md "- Area: calculation" "- Area: fees"
  (cd "$T" && node "$CHECK" --dir "$T/no-authority" --write-view > /dev/null)
  changes no-authority
  run 1 no-authority

  echo "== 6. Work resting on a proposal (a proposal treated as decided) =="
  copy work-on-proposal
  edit work-on-proposal sources.md "| SHOP-17 | Cancel an order from the orders page | D-05 |" "| SHOP-17 | Cancel an order from the orders page | D-05 |
| SHOP-18 | Waive the fee for 6+ tickets at checkout | P-03 |"
  changes work-on-proposal
  run 1 work-on-proposal

  echo "== 7. A correct promotion, checked against the earlier copy =="
  echo "Avery Lane approves P-01 in a new meeting: a new decision D-08 is added (From: P-01), and P-01"
  echo "gets one added line (Became: D-08). The check compares with the log as it was before."
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
  (cd "$T" && node "$CHECK" --dir "$T/promotion" --write-view > /dev/null)
  changes promotion
  run 0 promotion --previous earlier-log.md

  echo "== 8. A status changed by rewriting the earlier entry =="
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
  changes rewrite
  run 1 rewrite --previous earlier-log.md

  echo "== 9. A replaced decision that no longer links to its replacement =="
  copy one-way
  edit one-way log.md "- Affects: SHOP-13
- Replaced by: D-07" "- Affects: SHOP-13"
  changes one-way
  run 1 one-way

  echo "== 10. A source that doesn't exist, and a date that isn't one =="
  copy no-source
  edit no-source log.md "- Source: SUP-04" "- Source: SUP-99"
  edit no-source log.md "- Date: 10-26-2026" "- Date: 13-26-2026"
  changes no-source
  run 1 no-source

  echo "== 11. A Current decisions view edited by hand =="
  copy stale-view
  edit stale-view log.md "| D-01 | The service fee is \$2.50 per ticket |" "| D-01 | The service fee is \$2.00 per ticket |"
  changes stale-view
  run 1 stale-view

  AFTER=$(cd "$REAL" && cat log.md rules.md sources.md | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(d).digest("hex")))')
  echo "== The real files were only read =="
  echo "SHA-256 of log.md, rules.md and sources.md together, before: $BEFORE"
  echo "and after:                                                   $AFTER"
  if [ "$BEFORE" = "$AFTER" ]; then echo "identical"; else echo "THE REAL FILES CHANGED"; FAIL=1; fi
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
