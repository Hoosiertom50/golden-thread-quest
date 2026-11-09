# Proof · playwright-page-model

Attempt: `playwright-attempt-005`

Decisions by Tom Carter; the review screen, page models, tests, change record and these notes
drafted with Claude (Claude Code), 11-06-2026 to 11-09-2026. Everything runs against the local Tixly
demo app with made-up data; nothing is saved or sent anywhere.

## What was built

A second screen for the local Tixly demo app, page models for both screens, and four tests that
use only the models.

- **The order review screen** (`demo-app/review.html`, new). The events page's ticket picker is now
  a form: choosing a quantity and pressing the button opens `/review?event=...&quantity=...`. The
  review screen shows an **Order summary** table (Event, Tickets, Total) and a **Back to events**
  link. If the address asks for an event that isn't on sale, or a quantity outside 1 to 6, it shows
  a message instead of a total. Nothing is saved; the screen only shows what its address describes.
- **The demo server** (`demo-app/server.js`) now serves both pages (`/` and `/review`). It still only
  answers GET requests and still listens on this computer only.
- **The page models** (`pages/models.ts`, new): `EventsScreen` and `OrderReviewScreen`. Every way of
  finding something on either screen lives here, by role, label or visible text. Methods are named
  for what a user does or reads: `chooseTickets`, `reviewOrder`, `chooseTicketsAndReview`,
  `backToEvents`, `openFromLink`, `eventName`, `ticketCount`, `orderTotal`, `problem`. There are no
  assertions in the file.
- **The tests** (`model-usage.spec.ts`, new): four tests, written only against the models.
  1. A buyer reviewing 2 Spring Concert tickets sees the event, 2 tickets and a total of $55.00.
  2. A buyer who goes back from the review to choose 4 tickets instead sees the new total of
     $110.00.
  3. A review link asking for 9 tickets explains the 1 to 6 limit instead of showing a total.
  4. A review link naming an event that isn't on sale says so instead of showing a total (added
     after the change record; see "My own review" below).
- **The deliberate interface change, kept:** the events page's button is now **Continue to review**
  (it was **Review order**). That is the change in the change record, and the app keeps it so the
  code handed in matches the evidence.

My decisions:

- **Build a second screen rather than split the one page into parts.** The quest asks for at least
  two screens; a real next step after choosing tickets (reviewing the order) gave the models a
  journey to cover, including going back and forth between screens.
- **Leave the previous quest's page model and test untouched.** `pages/example-page.ts` and
  `first-independent-test.spec.ts` are exactly as they were approved. This quest's models are in a
  new file, so the earlier work stays as evidence of that quest.
- **Keep the "is it right?" checks in the tests** (see "What belongs in the model" below).

## The one-file diff

From `logs/change-record.txt`: after the button was renamed in the app (its own commit), the tests
that press it failed, and this was the whole fix. `git status` and `git diff --stat` show this one
file and nothing else:

```diff
diff --git a/participant/tests/playwright/pages/models.ts b/participant/tests/playwright/pages/models.ts
--- a/participant/tests/playwright/pages/models.ts
+++ b/participant/tests/playwright/pages/models.ts
@@ -9,7 +9,7 @@ import type { Locator, Page } from "@playwright/test";
 // models find and do, and the tests decide whether the result is right.
 
 // The events page (/): one card per event, with a ticket quantity, a running total and a
-// "Review order" button.
+// "Continue to review" button.
 export class EventsScreen {
   constructor(private readonly page: Page) {}
 
@@ -28,7 +28,7 @@ export class EventsScreen {
 
   // Go on to the review screen for the tickets chosen on an event's card.
   async reviewOrder(eventName: string): Promise<void> {
-    await this.event(eventName).getByRole("button", { name: "Review order" }).click();
+    await this.event(eventName).getByRole("button", { name: "Continue to review" }).click();
   }
 
   // Choose tickets and go straight to the review screen, the most common path through this page.
```

The first change is the comment that names the button; the second is the locator itself.

## What belongs in the model

**The decision:** the model finds things and does things; it never decides whether a result is
right. `orderTotal()` returns *where* the total is; the test says it must be `$55.00`.

I was tempted to have the model check the total too, but I kept that in the test, because the
person checking the work shouldn't be the same one doing it. If the model said "the total is
correct", a test could no longer disagree with it, and a mistake in the model would hide a mistake
in the app.

What did go into the model: anything a UI change could break (labels, roles, button names, the
table's row headings) and steps that more than one test repeats (`chooseTicketsAndReview`).

## Where the important artifacts are

All paths are under `participant/`.

| What | Path |
|---|---|
| The page models (two screens) | `tests/playwright/pages/models.ts` |
| The four tests | `tests/playwright/model-usage.spec.ts` |
| The order review screen (new) | `tests/playwright/demo-app/review.html` |
| The events page (form and button) | `tests/playwright/demo-app/index.html` |
| The demo server (now two pages) | `tests/playwright/demo-app/server.js` |
| README and setup check (updated) | `tests/playwright/README.md`, `tests/playwright/tools/project-setup-check.ts` |
| The change record | `evidence/playwright-page-model/playwright-attempt-005/logs/change-record.txt` |

## How to reproduce the behavior

With the project set up as its README says (`npm ci --engine-strict`, then
`npx playwright install chromium`), from `participant/tests/playwright`:

```
npx playwright test
```

All 6 tests pass (the 4 here, plus the project-setup and first-independent-test quests' tests).
To repeat the change record: rename the button in `demo-app/index.html` (for example back to
"Review order"), run the command again and see the two tests that press it fail on
`pages/models.ts` line 31; change only that line's button name to match, and they pass.

## How the work meets the criteria

1. **No test file contains a raw selector.** `model-usage.spec.ts` only calls model methods and
   asserts. Checked by searching it for `getBy`, `locator(`, `querySelector`, `page.`, CSS and XPath
   patterns: no matches.
2. **The model covers at least two screens:** `EventsScreen` (the events page) and
   `OrderReviewScreen` (the order review page).
3. **Assertions about business behavior stay in the tests:** every `expect` (the event, the ticket
   count, the $55.00 and $110.00 totals, the 1 to 6 and "isn't on sale" messages) is in
   `model-usage.spec.ts`. Searching
   `pages/models.ts` for `expect` finds nothing.
4. **A locator change is fixed by editing only the model:** `logs/change-record.txt` shows the suite
   passing (5 of 5), then the button renamed in the app and committed on its own, then 2 tests
   failing while waiting for the old button name at `pages/models.ts:31`, then the model fixed and
   the suite passing again (5 of 5).
5. **The Git diff of that change touches no test file:** in the same record, `git status`,
   `git diff --stat` and `git diff` show only `pages/models.ts` (2 lines). The diff is above.
6. **Methods are named for user actions:** `chooseTickets`, `reviewOrder`, `backToEvents`,
   `openFromLink`, and for what the user reads: `orderTotal`, `ticketCount`, `problem`. None is
   named for an element.
7. **A new test can reuse the model without copying code:** tests 1 and 2 both use
   `chooseTicketsAndReview`; test 2 also goes back with `backToEvents` and reuses the same method on
   the screen it returns. Tests 3 and 4 are a different way in (`openFromLink`) and still read the same
   `orderTotal` and `problem`; test 4 reuses `openFromLink` for two addresses in a loop.

## What was tested or validated

- **The change record** (`logs/change-record.txt`, 11-09-2026, 10:08 AM to 10:09 AM): before 5
  passed; after the interface change 2 failed and 3 passed; after the model fix 5 passed; only
  `pages/models.ts` changed. The suite had 5 tests then (test 4 came later). Only 2 of the 3 new tests failed because the third opens the review
  screen from a link and never presses the button; the two earlier quests' tests don't press it
  either.
- **The tests catch the bugs they are for:** on 11-06-2026 I made the review screen charge the fee
  once per order: tests 1 and 2 failed, receiving $52.50 and $102.50. I removed the 1 to 6 limit:
  test 3 failed. The review screen was put back byte for byte each time.
- **Earlier work still passes:** the project-setup and first-independent-test quests' tests pass in
  every run above.
- **This quest has no automatic checker.** The criteria above were checked against the files and
  the change record.
- **My own review before Copilot** found four things, all fixed after the change record (none
  touches the page models):
  - A review link naming something every JavaScript object has, such as `?event=constructor`,
    showed the event as "Object" and the total as "$NaN" instead of "That event isn't on sale".
    The review screen now only accepts events it lists; the same links now show the message.
    Test 4 was added to guard it: with the old lookup put back it failed (no message appeared),
    and with the fix it passes. The page was put back byte for byte after that trial.
  - The project README still said a run ends with `2 passed`; it now says `6 passed` and names the
    new tests and their tag.
  - The project-setup check didn't cover the 3 new files; it now checks 15 project files instead
    of 12, and passes.
  - The test-data notes at the top of `model-usage.spec.ts` didn't list the 9-ticket case; they now
    list it, and the "isn't on sale" case.

## Stretch goals

Not attempted: a component model reused by two pages, and an automatic check that tests contain no
selector. Criterion 1 was checked by a search, run by hand, not by a check in the suite.

## Remaining limitations

- **The price is written twice.** The events page keeps the Spring Concert's price and fee on its
  card, and the review screen keeps its own copy. A real app would get both from its server; here,
  changing one and not the other would make the two screens disagree.
- **One event, one browser (Chromium).**
- **The review screen trusts its address.** It checks the event and the quantity (1 to 6), but
  there's no order behind it: nothing is saved and no payment is involved.
- **Files from the project-setup quest changed:** `demo-app/server.js` and `demo-app/index.html`
  were changed for this quest (two pages, the form and the renamed button). The quest app's content
  check does not flag them; its 3 notes (the project-setup quest's README, configuration and setup
  check changed since approval) are the same 3 explained in the first-independent-test quest's
  hand-in, and nothing new. Both earlier quests' tests still pass.

## Sensitive values

No password, token, customer name or private ticket content is here. The tests use no credential,
and all data in the demo app is made up. The change record shows personal home-folder paths as `~`.
Every file in this evidence was scanned with the quest app's credential patterns: 0 findings.
