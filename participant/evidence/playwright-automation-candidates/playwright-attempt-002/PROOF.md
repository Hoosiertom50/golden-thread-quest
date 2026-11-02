# Proof · playwright-automation-candidates

Attempt: `playwright-attempt-002`

Decisions by Tom Carter; wording, the check script and its tests drafted with Claude (Claude Code),
11-02-2026. Tixly and everything about it are invented; no application was touched.

## What was built

- **Automation criteria:** six criteria (Needed, Objective, Stable, Regression, Value, Cost), each
  with one question and fixed answers, and a six-step rule that turns the answers into automate,
  manual or drop. Regression was my addition: whether a check will be in the regression suite is
  the first thing I ask in my own testing work.
- **Fifteen decided test ideas** for the Tixly checkout, drawn from my layered test strategy (quest
  "Turn Requirements and Risk into a Layered Test Strategy"): 8 automate, 6 manual, 1 drop. Each
  gives the facts, my answer to each criterion the rule needed, the decision and the rule step that
  gave it, the reason, and for a manual idea how it will be checked instead. My decisions were
  recorded on 11-02-2026, before the second person's answers.
- **A brief for the second person:** the criteria and rule word for word, and 10 of the ideas with
  exactly the facts I decided from, without my answers, decisions or reasons.
- **A TypeScript check** that reads the rule from the criteria file and re-applies it to every
  idea, confirms the brief matches the files and gives nothing away, and compares the second
  person's independent decisions with mine.

## Where the important artifacts are

| What | Path |
|---|---|
| Criteria and rule | `participant/context/playwright/automation-criteria.md` |
| Decisions | `participant/context/playwright/candidate-decisions.md` |
| What the second person was given | `participant/context/playwright/second-person-brief.md` |
| Second person's decisions | `participant/context/playwright/second-person-decisions.md` |
| Check script | `participant/tests/playwright/tools/automation-candidates-check.ts` |
| Check output | `participant/evidence/playwright-automation-candidates/playwright-attempt-002/logs/decision-check.txt` |

## How to reproduce the behavior

From the repository root, with Node 22.18 or later (it runs TypeScript directly; nothing to
install, and the script uses only Node's built-in modules):

```
node participant/tests/playwright/tools/automation-candidates-check.ts
```

It prints the same output as `logs/decision-check.txt`. It reads the four files and writes
nothing. Exit status: 0 passed, 1 failed, 2 a required file couldn't be read.

## How the work meets the criteria

1. **The criteria are written and used consistently.** Each criterion has one question and fixed
   answers, and one rule, in a fixed order, turns the answers into a decision. The check reads the
   rule as written and re-applies it to every idea: each decision, and the rule step that gave it,
   must be exactly what the rule gives for that idea's answers.
2. **Every idea has a decision of automate, manual or drop:** all 15, and the check confirms there
   are at least 12, each with exactly one of the three.
3. **Every decision names at least one criterion:** each idea lists its answers to the criteria the
   rule needed (from C1 up to the deciding step) and names the rule step, with a reason.
4. **At least three ideas are not automated:** 7 are (6 manual and 1 drop).
5. **A manual decision says how it will be checked instead:** each of the 6 manual ideas has a
   "Checked instead" line naming who checks what and how often; the check refuses a manual idea
   without one, and the line on any idea that isn't manual.
6. **A reviewer reapplying the criteria reaches the same decision for at least three of every
   four ideas:** [SECOND PERSON'S RESULT]
7. **No decision relies only on how easy it is to automate:** cost is the last criterion the rule
   looks at, and only for a regression check that is already needed, objective, stable and
   valuable; the check confirms no rule step decides on cost alone. "Easy" never appears as a
   reason: a dropped idea (I-11) is dropped because it repeats another, however easy it would be.

## The decision I was least sure of

**I-08: a seat hold reaching 10 minutes while its payment is still being processed, tested against
the payment provider's own test environment** (criteria 1, 5 and 7). My rule says automate: it is
needed, objective, stable, part of regression, and value 3, the worst outcome in the strategy, a
seat sold to two buyers. Step D5 automates it even at high cost.

I was least sure because of the real service. It is outside our control: it can be slow, down, or
behave differently from day to day, so an automated test against it could fail for reasons that
have nothing to do with Tixly, and a suite that fails for outside reasons teaches people to ignore
its failures. I kept "automate" because that is what my criteria give, and because a stand-in
payment service can't show how the real one behaves, which was the point of my reflection in the
layered test strategy quest. If the test turns out to fail for outside reasons, that would show
the cost is higher than "high" can express, and I would decide it again as manual: a tester runs
it against the real service each release.

I left I-08 out of the second person's list on purpose, because it was the decision most likely to
divide two careful people. That choice may make the share of matching decisions a little higher
than it would be with I-08 included, and I say so here rather than leave it unstated.

## Reflection

**Which test did I keep manual that a colleague would want automated, and what would change my
mind?**

**I-07, the confirmation email actually arriving in a real inbox within 5 minutes,** is the one a
colleague would most likely want automated. They would argue it is needed, it has a definite result
(it arrived, on time, with every detail), and it runs every release, so why not let a machine do
it? I kept it manual because of the cost: a test that waits on a real inbox needs a real email
account, depends on a real email service it doesn't control, and fails whenever delivery is slow,
so it would break for reasons that aren't Tixly's. The value is 2: a late email misleads the buyer,
but no money is lost and no seat goes to the wrong buyer, and my rule automates at high cost only
when the value is 3.

What would change my mind: a test inbox service that receives mail through the real email service
and is cheap and reliable to read automatically. Under my criteria as written, that still counts
as high cost, because it uses a real outside service, so automating it would mean changing C6 to
count such a service as low cost. That would be a deliberate change to the criteria, applied to
every idea, not just this one.

## What was tested or validated

- **The check on the real files:** [RESULT], as recorded in `logs/decision-check.txt`.
- **Strict type check:** the script was type-checked with TypeScript 6.0.3 in strict mode, in a
  temporary folder outside this repository, as in the layered test strategy quest; it passed
  first time.
- **Tests of the check itself (kept locally, not handed in):** 87 altered copies of the files, each
  expected to fail in one named way (or to pass), with 0 unexpected results; and 56 deliberately
  broken copies of the script, each with one rule switched off, all of which those tests caught.
- **Copilot review:** [ROUNDS]

## Stretch goals

Not attempted: a numeric score for each idea compared with my gut decision, and revisiting the
decisions after a month.

## Remaining limitations

- **The check proves the decisions follow from the answers, not that the answers are right.**
  Whether an idea really is stable, valuable or costly is a judgment; the second person's
  comparison is the evidence for that.
- **The second person saw 10 of the 15 ideas.** That keeps their part to about ten minutes and is
  more than the six the quest asks for. I-08, the decision I was least sure of, was left out on
  purpose (see above), which may raise the share that match, and means the comparison doesn't test
  rule step D5 (automate a value-3 regression check despite high cost).
- **Some facts are assumed,** for example that the payment page's order summary panel is being
  redesigned (I-14). They are stated in each idea's facts, so a second person decides from the
  same assumptions.
- **This is a plan.** No test was built or run; the decisions say which tests would be automated.

## Sensitive values

No secret, token, customer name or private ticket content is in this hand-in. Tixly and its
requirements are invented. The second person is named as they agreed.
