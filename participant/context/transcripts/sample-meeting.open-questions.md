# Open questions: sample-meeting (Seating Chart Refinement, Sprint 14)

Derived from `participant/context/transcripts/sample-meeting.md`, the source of record, which is not
edited. Sorted by the rules in `participant/context/open-question-rules.md`: only a definite answer
closes a question, and a promise to find out keeps it open with the person who promised as its
owner. Every entry cites utterance identifiers (U001 to U041) and quotes them word for word. Check
it with `python3 participant/tools/check-open-questions.py`. Decisions by Tom Carter; written by
Claude (Claude Code), 11-23-2026. Nothing here answers a question or contacts anyone.

## Counts

- Open questions: 4
- Closed in the meeting: 9
- Not counted: 1

## Open questions

### Q1 · Does dragging work by touch on tablets?

- Raised: U021 "Does this work on the iPad?"
- Raised by: uncertain speaker (U021, as the transcript records it)
- Kept open by: U024 "let's log it as an open question: touch support on tablets"
- Owner: not stated
- Due: not stated
- Why open: nobody answers it; it is logged as open (U024) and moved out of this story (U026
  "Out of scope for now, separate story later"), which defers it without answering it.

### Q2 · Does undo cover drops?

- Raised: U017 "Do we undo a drop?"
- Raised by: Priya Shah (U017)
- Kept open by: U018 "It should cover drops for free."
- Owner: Priya Shah, U019 "I'll test it rather than assume it."
- Due: not stated
- Why open: the only answer is hedged ("should"), and Priya promises to find out by testing; the
  build she can test arrives Wednesday afternoon (U020), but no date is stated for the answer.

### Q3 · Do first-time users need a drag hint?

- Raised: U035 "whether we need a drag hint for first-time users"
- Raised by: Dana Ruiz (U035)
- Kept open by: U035 "And the open questions:"
- Owner: not stated
- Due: not stated
- Why open: named as an open question in the wrap-up, and nothing after it answers it.

### Q4 · What do screen readers announce when a drop is refused?

- Raised: U036 "what screen readers announce when a drop is refused"
- Raised by: Priya Shah (U036)
- Kept open by: U037 "Good, add it."
- Owner: not stated
- Due: not stated
- Why open: added to the open questions (U037), and nothing after it answers it; who adds it is
  not who answers it.

## Closed in the meeting

### C1 · Does the dropdown stay?

- Raised: U003 "The dropdown stays, though, right?"
- Answered: U004 "Yes, both. Drag is an extra, not a replacement."

### C2 · Is it a hover preview of the table's guests?

- Raised: U006 "So a hover preview of the table's guests?"
- Answered: U007 "Exactly. Names and how many seats are left."

### C3 · What happens on a drop onto a full table?

- Raised: U009 "What happens if they drop someone on a full table?"
- Answered: U011 "A message, please. Shaking alone isn't clear enough."

### C4 · What if a guest has a plus-one and only one seat is left?

- Raised: U012 "And if the guest has a plus-one and only one seat is left?"
- Answered: U014 "Agreed. A party always moves as one."

### C5 · What about the head table?

- Raised: U015 "What about the head table?"
- Answered: U016 "Locked tables refuse drops."

### C6 · Can there be a build by Wednesday?

- Raised: U019 "Can I get a build by Wednesday?"
- Answered: U020 "Wednesday afternoon, yes."

### C7 · Can venues print the chart after arranging it?

- Raised: U030 "can they print the chart after arranging it?"
- Answered: U031 "Printing exists already."

### C8 · Is anything new needed for printing?

- Raised: U031 "Is anything new needed?"
- Answered: U033 "That's a test case, not a feature."

### C9 · Can there be an estimate by tomorrow?

- Raised: U039 "Marcus, estimate by tomorrow?"
- Answered: U040 "Yes, by noon."

## Not counted

### N1 · Who raised the iPad question?

- Raised: U022 "Who was that, Sam?"
- Why not counted: a question about the meeting, not the work; Sam does not know (U023), and the
  meeting chose not to pursue it (U024 "Either way"). The iPad question's speaker stays recorded
  as uncertain.

## Compared with the decisions file

`sample-meeting.decisions.md` (quest 25) lists three open questions: O1 tablet touch (U021), O2 drag
hint (U035) and O3 screen readers (U036), the same as Q1, Q3 and Q4 here. The one difference is
Q2, undo for drops: the decisions file records "undo covers drops" as decision D7, marked "not yet
confirmed" because it rests on Marcus's "should" and Priya will test it. Both hold: the group agreed
the behaviour (a decision), and whether undo actually covers drops is still unanswered (an open
question), owned by Priya. Nothing here contradicts what the decisions file quotes.
