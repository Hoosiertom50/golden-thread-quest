# Decision log rules

The rules for `participant/context/decisions/log.md`, from the context-decision-log quest. The
project is made up: the demo shop in `participant/tests/playwright/demo-app/` (one event, the
Spring Concert, $25.00 a ticket plus a $2.50 service fee per ticket). Every person, meeting and
work item named here is invented. Decisions by Tom Carter; wording drafted with Claude (Claude
Code), 11-19-2026.

The checker (`participant/tools/decision-check.mjs`) reads the **Who may approve** table below, so
the people a reader sees here are the only people it accepts as approvers.

## The three kinds of entry

Every entry has exactly one status:

- **decision**: approved by a person with the authority to approve it, in writing. It is in force
  until another decision replaces it.
- **proposal**: an idea someone has put forward. However many people like it, it is not decided.
- **question**: something nobody has answered yet.

## What makes an entry a decision

An approval needs **both**:

1. **A named approver with authority** for that kind of decision, from the table below.
2. **A written record** of their approval: a line in the meeting notes or a comment on a work item
   in which that person approves it ("Approved by Avery Lane: …"). The entry quotes that line
   exactly, and names where it is.

**People agreeing is not an approval.** "Everyone agreed", "sounds good" or a nod in a meeting
leaves the entry a proposal until someone with authority approves it in writing. Nobody records a
decision on someone else's behalf: the approval must be in the approver's own words.

## Who may approve

| Approver | Role | May approve |
|---|---|---|
| Avery Lane | Product owner (made up) | `fees` `ticket limits` `pages` |
| Sam Ortiz | Tech lead (made up) | `calculation` |

Each decision names its **Area**, one of: `fees` (prices and fees), `ticket limits` (how many
tickets an order may have), `pages` (what the shop's pages show or let a buyer do) and
`calculation` (how amounts are worked out and stored). A decision approved by anyone else, or by
one of them outside their areas, is not a decision.

## How a proposal becomes a decision

Entries are never rewritten, like lines in a checkbook. When a proposal is approved:

1. a **new decision** entry is added, with `From: P-nn`;
2. the proposal stays as it was, and gets one added line: `Became: D-nn`.

## How a decision is replaced

1. a **new decision** entry is added, with `Replaces: D-nn`;
2. the old decision stays as it was, and gets one added line: `Replaced by: D-nn`.

The only lines ever added to an existing entry are `Became` and `Replaced by`. Nothing in an entry
is ever changed or removed.

## The current decisions

The **Current decisions** list at the top of the log shows only the decisions in force: those not
replaced. Nobody writes it by hand: the checker builds it from the entries
(`node participant/tools/decision-check.mjs --write-view`), so it can never disagree with them.

## Work items

Each decision lists the made-up work items it affects (`Affects: SHOP-nn`). A work item must rest
on a decision, never on a proposal or a question: that is how an idea quietly becomes "the
decision" without anyone approving it.
