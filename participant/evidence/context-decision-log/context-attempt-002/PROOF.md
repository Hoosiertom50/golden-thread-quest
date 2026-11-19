# Proof · context-decision-log

Attempt: `context-attempt-002`

Written by Tom Carter with Claude (Claude Code), 11-19-2026. The choices below are Tom's, from his
answers to one question at a time; Claude wrote the files and this page from them.

## What was built

A decision log for a made-up project, the rules it follows, and a checker that tests it against
every acceptance criterion.

**The project (Tom's choice).** The demo shop already in this repository
(`participant/tests/playwright/demo-app/`): one event, the Spring Concert, $25.00 a ticket plus a
$2.50 service fee per ticket. Every person, meeting, document and work item is invented; nothing
comes from a real project.

**The log** (`participant/context/decisions/log.md`): 13 entries, 7 decisions, 3 proposals and 3
questions, each with its date and source (criteria 1 and 6). It includes a replaced decision (D-02,
"at most 6 tickets", replaced by D-07, "at most 8 tickets"), a promoted proposal (P-02, "let buyers
cancel an order from the orders page", became D-05), and the quest's trap: P-03, "waive the fee for 6 or more tickets", which
everyone in a meeting agreed was a good idea but nobody with authority approved, so it stays a
proposal.

**The rules** (`participant/context/decisions/rules.md`): what makes an entry a decision, who may
approve which areas (a made-up product owner for fees, ticket limits and pages; a made-up tech lead
for calculations), how a proposal becomes a decision and how a decision is replaced.

**The sources** (`participant/context/decisions/sources.md`): the made-up meeting notes, document
and comments the entries cite, and the work items with the decision each rests on.

**The checker** (`participant/tools/decision-check.mjs`): one PASS or FAIL per acceptance
criterion, naming every problem, plus the two stretch goals. Given an earlier copy of the log, it
also proves the log was only added to. It builds the Current decisions view, and only when every
other check passes.

## How an approval is told apart from agreement

Tom's rule: **an approval needs a named approver with authority and a written record in their own
words.** Agreement in conversation ("everyone agreed it was a good idea", "sounds good") is not an
approval, however many people agree.

- A decision names its **Approver**, who must be in the rules' "Who may approve" table, and its
  **Area**, which must be one that person may approve (criterion 2).
- The **Approval** quotes the approver's own line from the cited source, word for word, and the line
  must read "Approved by <approver>: …". The checker finds that line in the source; a quote from
  anyone else, or of agreement, is refused (criteria 2 and 3). Nobody records a decision on someone
  else's behalf.
- **Each approval backs one decision**, and the Current decisions view shows the approver's own
  approved words, not the entry's title: what a reader sees as decided is exactly what was approved,
  and a decision can't borrow another's approval (criteria 2 and 7).
- Until then the entry stays a **proposal**: it never appears in the Current decisions view, has no
  approver, and no work item may rest on it (criterion 3).

Case 2 of the check shows it: P-03 turned into a decision whose "approval" quotes the meeting's
agreement fails with "agreement is not an approval", although the line is in the notes word for
word.

## Choices (Tom's)

1. **The made-up project** is the repository's demo shop, never a real one.
2. **Approval** = a named approver with authority + a written record (above).
3. **The Current decisions view is built by the checker** from the entries (`--write-view`), never
   by hand, so it can't disagree with them; a hand-edited view fails, and the checker refuses to
   write the view over a log with any other problem (criterion 7).
4. **Entries are never rewritten.** Promoting a proposal adds a new decision (`From: P-nn`) and adds
   one line to the proposal (`Became: D-nn`); replacing a decision adds a new one (`Replaces`) and
   one line to the old (`Replaced by`). The checker confirms both links point both ways, that a new
   entry comes after the one it promotes or replaces, and, given an earlier copy, that its entries
   are still first, in order, with only those two kinds of line added (criteria 4 and 5).
5. **Both stretch goals:** each decision lists the work items it affects and each work item names
   the decision it rests on, checked both ways; the checker lists decisions in force with no work
   resting on them (D-06, "prices in US dollars").

## Which decision I would least want to be asked about

Tom: **D-07, "at most 8 tickets".** It replaced the limit of 6 four weeks after that was approved,
after group buyers asked support for more tickets. The obvious question is "why did we change our
minds so fast, and will it change again?" The log shows what was decided, when and by whom, but not
the numbers behind the change.

## Where the important artifacts are

All paths are under `participant/`.

- The log: `context/decisions/log.md`
- The rules: `context/decisions/rules.md`
- The sources and work items: `context/decisions/sources.md`
- The checker: `tools/decision-check.mjs`
- The demonstration that recorded the check: `tools/decision-check-demo.sh`
- The check's output: `evidence/context-decision-log/context-attempt-002/logs/log-check.txt`. It
  ends with the full text of `sources.md` and the checker's SHA-256, so the approvals can be verified
  from the evidence alone.

## How to reproduce the behavior

From the repository's top folder:

```sh
node participant/tools/decision-check.mjs
node participant/tools/decision-check.mjs --previous <an earlier copy of log.md>
node participant/tools/decision-check.mjs --write-view
bash participant/tools/decision-check-demo.sh <a new logs folder>
```

The demonstration copies the three files into a new temp folder, breaks each copy in one way, runs
the checker on each, writes `log-check.txt` only if every result is as expected, and deletes the
temp folder. The real files are only read.

## What was tested or validated

Recorded on 11-19-2026 at 12:26 PM with Node 22.23.3, at commit f1dae45 with the quest-24 files
uncommitted (`logs/log-check.txt`). Each broken case is a copy of the real files with one mistake
and its Current decisions list rebuilt, and must fail exactly the checks named for it, with the
expected message, and pass every other check:

1. **The real log passes every check:** 13 entries; all seven criteria and the stretch check PASS.
2. **Agreement recorded as an approval** (the quest's scenario): check 2 fails, "agreement is not
   an approval" (criteria 2 and 3).
3. **A decision with no approver:** checks 1 and 2 fail (criteria 1 and 2).
4. **An approval quote changed from the source** ($2.50 to $2.00): check 2 fails, not in the
   source word for word (criterion 2).
5. **An approver outside their authority** (the tech lead approving a fee): check 2 fails.
6. **A decision borrowing another decision's approval** (a "fee waived" decision citing the $2.50
   approval): check 2 fails, "uses the same approval as D-01".
7. **A work item resting on proposal P-03:** check 3 fails, work must rest on an approved decision
   (criterion 3).
8. **A correct promotion** (P-01 approved in a new meeting: a new D-08 added at the end, P-01 given
   `Became: D-08`), checked against the earlier log: every check passes (criterion 4).
9. **The same promotion done by editing P-01 in place:** check 1 and the history check fail, the
   history check naming each changed, removed and added line (criteria 1 and 4).
10. **A replaced decision with its link removed:** check 5 (and the work-item link) fails
    (criterion 5).
11. **A decision that replaces itself:** check 5 fails.
12. **A source that doesn't exist and a 13th month:** check 6 fails (criterion 6).
13. **A Current decisions view edited by hand:** check 7 fails (criterion 7).
14. **`--write-view` on a log with a problem:** it refuses, and the file is unchanged byte for byte.

The demonstration writes the log only if every case came out as expected. The real files' SHA-256,
before and after, is identical.

## Remaining limitations

- **The checker trusts the sources file.** It confirms an approval line is in the cited notes, not
  that the meeting happened or that the person really said it. In a real project the source would
  be a link to minutes or a ticket comment a person can open.
- **"Authority" is only the table.** Who may approve what is whatever `rules.md` says; keeping that
  table right is a person's job.
- **Append-only is checked against a copy someone keeps.** Without `--previous`, the checker can't
  see that an entry was rewritten; in a real repository, Git's history is that earlier copy.
- **One log.** Decisions made in tickets or chat aren't found; they count only once added to the
  log.

## Sensitive values

No secret, token, password, customer name or real ticket content is here. Every name, meeting,
document and work item is invented, and the log shows only paths inside the repository or relative
to the demonstration's temp folder.
