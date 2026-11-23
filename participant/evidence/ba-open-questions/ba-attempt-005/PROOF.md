# Proof · ba-open-questions

Attempt: `ba-attempt-005`

Written by Tom Carter with Claude (Claude Code), 11-23-2026. The calls below are Tom's, from Tom's
answers to one question at a time; Claude drafted the list, wrote the checker and this page.

## What was built

From the transcript ingested in the first quest (`sample-meeting`, a synthetic 41-line refinement
meeting about drag-and-drop seating, written for the exercise), a list of every question the
meeting raised and what became of it:

- **The rules** (`participant/context/open-question-rules.md`): what counts as a question, what
  closes one, when an owner or due point may be recorded, and what isn't counted.
- **The list** (`participant/context/transcripts/sample-meeting.open-questions.md`): **4 open
  questions**, **9 closed in the meeting** (each with the line that answered it) and **1 not
  counted**, every entry citing utterance identifiers and quoting them word for word. It also
  says how it compares with the decisions file from the earlier quest.
- **The checker** (`participant/tools/check-open-questions.py`) and **its demonstration**
  (`participant/tools/open-question-check-demo.sh`), which runs it on the real list and on twelve
  copies, each with one planted mistake.

The transcript itself is never edited; the checker confirms it matches its committed copy.

## How I decided a question was answered

Tom's rule (criterion 2): **only a definite answer closes a question**, either a clear answer ("Yes,
both.") or a decision that settles it ("Locked tables refuse drops."), and it must come after the
question. **A promise to find out keeps it open**, and the person who promised becomes its owner.

That rule decided the hardest one, **"Do we undo a drop?" (U017)**. Marcus answers "It should cover
drops for free" (U018), and Priya replies "I'll test it rather than assume it" (U019). "Should" is
not definite, and Priya promised to find out, so it is **open, owned by Priya**, with no due point:
the Wednesday-afternoon build (U020) is when she can test, not a date for the answer. The decisions
file from the earlier quest records "undo covers drops" as a decision marked "not yet confirmed";
both are true: the behaviour was agreed, and whether it works is still unanswered.

The other borderline line, **"Who was that, Sam?" (U022)**, is **not counted**: it is about the meeting
rather than the work, and the meeting chose not to pursue it ("Either way", U024). The iPad
question's speaker stays recorded as uncertain.

## The open questions

| | Question | Raised | Owner | Due point |
|---|---|---|---|---|
| Q1 | Does dragging work by touch on tablets? | U021 (uncertain speaker) | not stated | not stated |
| Q2 | Does undo cover drops? | U017 | Priya Shah, U019 | not stated |
| Q3 | Do first-time users need a drag hint? | U035 | not stated | not stated |
| Q4 | What do screen readers announce when a drop is refused? | U036 | not stated | not stated |

Q1, Q3 and Q4 are the same three open questions as the decisions file (its O1 to O3).

## What was tested or validated

**The check (`logs/question-check.txt`, 11-23-2026 1:49 PM): 13 cases, all as expected.** The real list
passes: 41 utterances, 12 with a question mark, every one sorted once, and every line that declares an
open question raises or keeps open an entry; the transcript unchanged since it was committed. Each of
the twelve broken copies fails, naming its planted mistake. The checker's pass is structural: it
proves citations, quotes, order, owners, counts and completeness, and catches the common slips in
meaning; whether each call is right in meaning is Tom's judgment, set out above.

1. **Criterion 1, verified:** every entry cites the line that raised it, and the checker found every
   cited identifier in the transcript and every quote word for word in it; a copy citing U099 fails
   ("U099, which isn't in the transcript"), and so does one with a quote changed by one word.
2. **Criterion 2, verified:** a copy that moves "The dropdown stays, though, right?" (U003, answered
   by "Yes, both." at U004) into the open list fails with "U004 … reads like an answer". The checker
   looks at the five lines after each open question: a reply by someone else that reads like an
   answer must be explained in "Why open" unless it is already the answer to another question.
   Every closed question's answer comes after it (a copy answering U009 with U008 fails), and is not
   a promise or a hedge (a copy closing C5 with Priya's "I'll test it rather than assume it." fails).
3. **Criterion 3, verified:** an owner or due point is recorded only with the line that states it; the
   one owner, Priya Shah on Q2, cites U019, her own "I'll test it rather than assume it."
4. **Criterion 4, verified:** the owner of Q1, Q3 and Q4 and every due point is written "not stated",
   never guessed; a copy that makes Marcus Lee the owner of Q3, citing a line he neither said nor is
   named in, fails ("neither the speaker of U035 nor named in it"), and so does one that makes Sam
   Okafor an owner because "Same" in U016 contains his first name (names must be whole words).
5. **Criterion 5, verified:** none of the 15 questions is rhetorical; the rules say how one would be
   told apart (asked for effect, no answer expected) and that checks that got a real answer ("…,
   right?") are questions, closed.
6. **Criterion 6, verified:** the file holds questions only; a copy with a Decisions section added fails
   ("isn't allowed here"). Decisions, proposals and commitments stay in the decisions file.
7. **Criterion 7, verified:** each open question says why it is still open, and each closed one cites
   the line that answered it, so another person can check every call against the transcript; a copy
   that drops the printing question (U030) fails ("U030 asks a question … but isn't in any list"),
   and so does one that drops Q3, declared as an open question at U035 without a question mark.

Also checked: the counts match the lists (a copy saying 3 open fails), no id is used twice (a copy
with two Q3s fails), each entry holds only its own kind's fields, and every utterance id and quote
anywhere in the file, the reasons included, exists and matches.

## Choices (Tom's)

1. **I draft, Tom decides** every borderline call.
2. **A fresh pass, then a comparison** with the decisions file's open questions.
3. **Only a definite answer closes a question**; a promise to find out keeps it open, with the
   promiser as owner.
4. **The closed and not-counted questions are listed too**, so every question in the meeting is
   accounted for.
5. **U017 undo: open, owner Priya**, and **U022 "Who was that?": not counted**.

## Where the important artifacts are

- The rules: `participant/context/open-question-rules.md`
- The list: `participant/context/transcripts/sample-meeting.open-questions.md`
- The transcript (source of record, unchanged): `participant/context/transcripts/sample-meeting.md`
- The checker: `participant/tools/check-open-questions.py`; its demonstration:
  `participant/tools/open-question-check-demo.sh`
- The record: `participant/evidence/ba-open-questions/ba-attempt-005/logs/question-check.txt`

## How to reproduce the behavior

From the repository's top folder:

```sh
python3 participant/tools/check-open-questions.py
bash participant/tools/open-question-check-demo.sh <a new logs folder>
```

## Remaining limitations

- **"Answered later" is checked by wording, within five lines.** The checker can't understand
  meaning: an answer phrased without "yes", "agreed", "fine" and the like, or given more than five
  lines later, would not be flagged. The judgment is the person's; the check catches the common slip.
- **An owner is checked by who spoke or was named, not by what was promised.** A line said by
  someone who did not take the question on (say, "Good, add it.") would pass as that person's
  ownership; the rules, and the reviewer, decide whether a line really states an owner. The same
  goes for a due point: the checker binds it to its own quote, but whether that line sets the
  answer's deadline is a reviewer's call.
- **A closing answer is checked for order and for promise or hedge words, not for relevance.** That
  the cited line answers *this* question is the person's call, shown in each closed entry.
- **One synthetic meeting.** No real meeting, no real people; a real transcript would need its own
  redaction and permission first.

## Sensitive values

No secret, token, password, customer name or private ticket content is here. The transcript is
synthetic, written for the exercise; its four speakers are made up, and the two contact details in
it were redacted when it was ingested. Nobody named as an owner was contacted.
