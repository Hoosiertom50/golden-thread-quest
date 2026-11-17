# Proof · playwright-success-evidence

Attempt: `playwright-attempt-012`

Written by Tom Carter with Claude (Claude Code), 11-17-2026. The choices below are Tom's, from his
answers to one question at a time; Claude wrote the code and this page from them.

## What was built

One test that keeps evidence only where a business rule is proved, and nowhere else.

**The business rule (Tom's choice: the ticket total only).** On the review page, the total is
(ticket $25.00 + fee $2.50) × the number of tickets, so 6 Spring Concert tickets come to **$165.00**.
One rule means one piece of evidence (criterion 1).

**Which assertion is proof and which is navigation (criterion 3).** Each check in
`meaningful-evidence.spec.ts` is marked in a comment:

| Check | Marked | Evidence kept |
|---|---|---|
| Open the review page from a link for 6 tickets | NAVIGATION | none |
| The heading "Review your order" is visible | NAVIGATION | none |
| Event is Spring Concert, Tickets is 6 | NAVIGATION (the order the rule is applied to) | none of its own; both show in the proof's picture and are written in its values file |
| The total is shown (any value) | a wait before the proof | none |
| **The total is $165.00** (`expect(total).toHaveText(expected)`, line 81) | **PROOF** | **`order-total.png` + `order-total.txt`** |

Only the total check proves the rule. The others only show the test reached the right page with the
right order: they would pass just the same if the total were wrong. So navigation produces no
evidence (criterion 2), and the run's output says so, one "Not captured" line per navigation step.

**The evidence (Tom's choice: a picture of the summary plus a values file).**

- `order-total.png`: a picture of the order summary table only (Event, Tickets, Total), not the
  "Your name" box below it.
- `order-total.txt`: the rule, the event and tickets as the page showed them, the expected total with its working
  (($25.00 + $2.50) × 6), the total shown, whether the rule held, and when it was captured.

Together they show the specific value the rule is about (criterion 4), and a reader can tell what
was checked and whether it held without opening the test (criterion 7). Both are also attached to the
Playwright report automatically (stretch goal 1), and the values file records the exact value checked
next to the picture (stretch goal 2).

**When it is captured (Tom's choice: right before the check, every time).** The test waits until a
total is shown, captures the picture and the values file, and only then checks the total. So a
failing check still leaves the evidence of what the page showed.

**The contrast (Tom's choice: drop the fee).** `tools/break-ticket-fee.ts` makes a broken copy of the
demo app in a temporary folder, with one line changed: the review page's total leaves out the fee.
The real demo app is only read.

**The scan (criterion 6).** Quest 19's `tools/failure-evidence-check.ts`, unchanged, looks for keys,
tokens, cookies and the home-folder address. A new `tools/personal-data-check.ts` looks for buyers'
names (Tom's choice): every name saved in the demo app's orders, read when it runs, and the shape the
tests give their own orders ("Test User qa-…"). It reports file and line, never the name, and its
self-test plants a saved name and a made-up Test User name in a temporary copy and must find both.

## Where the important artifacts are

All paths are under `participant/`.

- The test: `tests/playwright/meaningful-evidence.spec.ts`
- The summary table for the picture: `summary()` in `tests/playwright/pages/models.ts`
- The broken copy: `tests/playwright/tools/break-ticket-fee.ts`
- The buyer-name check: `tests/playwright/tools/personal-data-check.ts`
- The passing run's evidence: `evidence/playwright-success-evidence/playwright-attempt-012/validated/`
  - `order-total.png`, `order-total.txt`: the one proof item
  - `run-output.txt`: the run, listing what was captured (1) and not captured (3)
- The contrast run: `evidence/playwright-success-evidence/playwright-attempt-012/logs/contrast-run.txt`,
  with its picture beside it as `contrast-order-total.png`

## How to reproduce the behavior

From `participant/tests/playwright`, with any made-up key in `TIXLY_API_KEY`:

```sh
npx playwright test meaningful-evidence.spec.ts
```

It passes, and the evidence is in `test-results/meaningful-evidence-…-chromium/order-total.png` and
`order-total.txt`. The contrast run:

```sh
node tools/break-ticket-fee.ts <a new, empty folder>
TIXLY_DEMO_PORT=4193 node <that folder>/server.js        # in a second terminal
TIXLY_BASE_URL=http://127.0.0.1:4193 npx playwright test meaningful-evidence.spec.ts
```

It fails at the total check, and `order-total.txt` says `Shown total: $150.00` and
`Result: RULE BROKEN`. The scans:

```sh
node tools/failure-evidence-check.ts <attempt>/validated
node tools/personal-data-check.ts <attempt>/validated
node tools/personal-data-check.ts --self-test <attempt>/validated
```

## What was tested or validated

All recorded on 11-17-2026 at 10:11 AM, at commit f73dcd7 with the quest-20 files uncommitted.

- **Passing run** (`validated/run-output.txt`): 1 passed. One item captured (the order total, shown
  $165.00, expected $165.00); three steps not captured, each navigation (criteria 1 and 2).
- **Contrast run** (`logs/contrast-run.txt`, criterion 5): the same test against the broken copy
  failed (exit 1) at line 81, "Expected: "$165.00" Received: "$150.00"", after retrying for its
  5-second limit. The evidence changed too: its values file says `Shown total: $150.00` and
  `Result: RULE BROKEN`, and its picture shows $150.00. The log puts the two values files side by
  side: only the shown total, the result and the time differ.
- **Scans of `validated/`** (`logs/contrast-run.txt`, sections 5 to 7, criterion 6): quest 19's check
  found nothing (exit 0); the buyer-name check found none of the 3 saved names and no Test User name
  (exit 0); its self-test found both planted names, at the right lines, and nothing else (exit 0).
  The saved logs were scanned the same way, with the same results.
- **By eye** (Tom, criterion 6): both pictures show only Event, Tickets and Total, with no name box
  and nothing personal; the first says $165.00 and the second $150.00.
- **The rest of the project:** the full suite, now 28 tests, ran with 24 passed and 4 skipped as
  before; `tools/tagging-check.ts` passed for all 28 (the new test carries `@order-review @risk-high
  @read-only @layer-ui @fast`); `tools/project-setup-check.ts` passed. The real
  `demo-app/data/orders.json` was unchanged after every run.

## Reflection: which capture would still look the same if the rule were broken?

Tom: **the picture on its own.** In the contrast run it shows $150.00 in a tidy summary, and nothing in
it says that is wrong. Only the values file next to it, which states the expected $165.00 and how it
is worked out, shows the rule was broken. A picture shows what the page displayed, not whether it
was right; it only proves something with the expected value beside it.

## Remaining limitations

- **The picture alone doesn't prove the rule** (the reflection above). It needs its values file.
  What Tom would do next: put the expected value into the picture itself, as a caption under the
  summary ("Expected $165.00"), so the picture alone no longer looks normal when the rule is broken.
- **One case of the rule.** Only 6 tickets is checked; quantities 1 to 5 are not.
- **Pictures are checked by eye.** The scanners can't read text in a picture; they list it for a
  person to check.
- **The name check knows only the names it is given:** those saved in the demo app's orders and the
  tests' own name shape. A name from anywhere else would not be recognised. Here the test never types
  a name and the picture leaves out the name box, so no name can get into the evidence.
- **A wrong total fails after 5 seconds, not at once:** the check keeps retrying in case the page is
  still updating.

## Sensitive values

No secret, token, cookie, customer name or private ticket content is in this attempt. The tests used
a made-up API key, new for each recording and never written down. The demo app is invented, with
made-up events and names. The logs show the home folder as `~`. The scans above found nothing in
`validated/` or `logs/`, and Tom checked both pictures by eye.
