# Tixly Playwright tests

Browser tests for Tixly, an invented ticket app, run against a small demo copy of the app on your
own computer. The tests never reach a public or production site. Written by Tom Carter, with
Claude (Claude Code), 11-05-2026.

This folder also holds checks from earlier quests (`tools/`); they need nothing from this setup
beyond Node.

## What you need

| Prerequisite | Version | How to check |
|---|---|---|
| macOS | written and run on macOS 27; Linux should work the same way but hasn't been tried; Windows isn't covered | |
| Git | any recent version (written and run with 2.39.2) | `git --version` |
| Node.js | 22.18 or later in the 22 line, or 23.6 or later (written and run with 22.23.3); 23.0 to 23.5 can't run the TypeScript checks | `node --version` |
| npm | comes with Node.js (written and run with 10.9.9) | `npm --version` |
| Internet access | for the first install only | |

Everything else comes from the steps below, at fixed versions: Playwright Test 1.63.0, installed
into this folder from `package-lock.json`, and the Chromium build made for it, which Playwright
keeps in its own cache folder outside the repository. Nothing else is installed.

## Set up and run

From a fresh copy of the repository:

1. Go to this folder:

   ```
   cd participant/tests/playwright
   ```

2. Install the exact package versions from the lockfile:

   ```
   npm ci --engine-strict
   ```

   `--engine-strict` makes npm stop with a clear message if your Node.js isn't a supported version
   (see the table above), instead of installing anyway and failing later with a confusing error.

3. Download the Chromium browser Playwright uses (a large download the first time; nothing is
   downloaded if the right version is already there):

   ```
   npx playwright install chromium
   ```

4. Run the tests:

   ```
   npm test
   ```

   Playwright starts the demo app on `http://127.0.0.1:4173`, runs 13 tests in Chromium (the
   smoke test in `tests/`, the ticket-total test, `first-independent-test.spec.ts`, the 6
   order-review tests, `model-usage.spec.ts`, the two locator-comparison tests, `brittle.spec.ts`
   and `stable.spec.ts`, and the 3 data-isolation tests, `isolated.spec.ts`) and stops the app
   again. A passing run ends with `4 skipped` and `13 passed`: the 4 skipped tests only run when
   asked (see "Saved orders and test data" below). The page tests find everything through the page
   models in `pages/`, except the locator-comparison and data tests, which write their locators out.
   To run only some tests, use their tag: `npx playwright test --grep @ticket-total`,
   `--grep @order-review`, `--grep @locator-comparison` or `--grep @data-isolated`.

   **Brittle and stable locators.** `brittle.spec.ts` finds things by how the page is built
   (positions, generated names, a path); `stable.spec.ts` checks the same thing by what a user
   sees. Both pass on the demo app. `demo-app-redesigned/` is a copy of the demo app with the same
   product built differently (a new event above, an extra line, a new box, renamed generated
   names). To run both tests against it, start the copy on another port and point the tests at it:

   ```
   TIXLY_DEMO_PORT=4199 node demo-app-redesigned/server.js
   ```

   then, in a second terminal, `TIXLY_BASE_URL=http://127.0.0.1:4199 npx playwright test --grep @locator-comparison`.
   The brittle test fails and the stable one passes. Press Ctrl+C in the first terminal to stop the
   copy. To count how many of each test's locators still find the right thing, run
   `node tools/locator-count.ts http://127.0.0.1:4199` while the copy is running. To count on the
   original page, start it by hand with `node demo-app/server.js` and use `http://127.0.0.1:4173`.

   **Saved orders and test data.** The demo app keeps saved orders in `demo-app/data/orders.json`
   (in Git, with three made-up "real" orders), through a small orders service in
   `demo-app/server.js`. The tests that save orders clean up after themselves, so after a run the
   file holds exactly the orders it held before. The app writes the file in its own layout (the
   layout it is committed in), so `git status` shows no change to it; a copy edited by hand in a
   different layout keeps its orders but comes back in the app's layout after the first save.
   - `isolated.spec.ts` (run every time): each test makes its own order, named like
     `Test User qa-1a2b3c4d-5e6f7a8b` (a run marker from `support/global-setup.ts`, then a code for the
     order), and `support/orders-fixture.ts` cancels exactly what it made when the test ends, pass
     or fail. After the run, `support/global-teardown.ts` cancels anything still carrying that
     run's marker, but never an order that existed before the run.
   - `coupled.spec.ts` (skipped unless `TIXLY_COUPLED=1`): a deliberately coupled pair that only
     passes in one order and can leave a "Test User" order behind.
   - `cleanup-proof.spec.ts` (skipped unless `TIXLY_CLEANUP_PROOF=1`): two tests that fail on
     purpose, to show their orders are still cleaned up.

   To run tests one at a time in a chosen order, and to check that nothing was left behind:

   ```
   node tools/data-isolation-check.ts before
   node tools/run-in-order.ts reversed isolated.spec.ts
   node tools/data-isolation-check.ts after
   ```

   `run-in-order.ts` takes `forward`, `reversed` or `random` (it prints the seed; `--seed <number>`
   repeats that order). The check ends with PASS when no test data is left and the orders that were
   there before are unchanged. If a run does leave an order behind, the check lists it; cancel
   it with its "Cancel order for ..." button on the "Your orders" page (`/orders`).

5. Optional: confirm generated files and environment files are ignored by Git, and scan the
   repository for credentials. This step also needs the repository's Python environment
   (`.venv`), which you have once the quest app is set up as the repository's main README
   describes; without it, the step stops and says so rather than passing:

   ```
   npm run check-setup
   ```

## Where the target address is set

The address the tests use is never written in a test. It is set in `playwright.config.ts` from
the environment:

- `TIXLY_BASE_URL`: the app's address. Left unset, the tests use the demo app they start
  themselves. If set, it must be on this computer (`127.0.0.1` or `localhost`); the configuration
  refuses any other address, so the tests can't reach a public or production site by mistake.
- `TIXLY_DEMO_PORT`: the port the demo app uses, `4173` unless set. Change it if that port is
  already in use.

For example, to use another port for one run:

```
TIXLY_DEMO_PORT=5174 npm test
```

## Credentials

The demo app needs no login, so no credentials are used. If a later test needs one, read it from an
environment variable in the test (for example `process.env.TIXLY_TEST_PASSWORD`) and set it in your
terminal before running. Never write a password, token or session cookie into a test, this folder
or a log. Environment files in this folder (`.env`, and names such as `.env.local`, `.env-local`,
`.env_production` or `production.env`) are ignored by Git, so they can't be committed by accident;
only `.env.example` is kept.

## What is kept out of Git

`node_modules/`, `test-results/` (traces, screenshots and downloads from runs),
`playwright-report/`, `blob-report/` and environment files (`.env`, `.env.*`, `.env-*`, `.env_*`
and `*.env`, except `.env.example`) are listed in `.gitignore`. Installing creates `node_modules/`
and running the tests creates `test-results/` and `playwright-report/`; none of them is committed.

## If the first run fails

| What you see | What to do |
|---|---|
| `npm ci` says the lockfile and `package.json` don't match | Make sure you are in `participant/tests/playwright` and haven't edited `package.json`; then run `npm ci --engine-strict` again. |
| `npm error code EBADENGINE` with `Required: {"node":"^22.18.0 \|\| >=23.6.0"}` | Your Node.js isn't a supported version: install 22.18 or later in the 22 line, or 23.6 or later, from nodejs.org, open a new terminal, check `node --version`, then run `npm ci --engine-strict` again. The `--engine-strict` option in step 2 makes npm stop here on purpose, rather than install and fail later with a confusing error. |
| `node: command not found`, or `node --version` shows an older version than you installed | Node isn't installed, or another copy is found first. Run `which -a node` to list every copy; the first one is the one used. Open a new terminal after installing, or put the newer copy first. |
| `Executable doesn't exist` or `browserType.launch` errors | The browser isn't installed yet: run `npx playwright install chromium`. |
| `http://127.0.0.1:4173 is already used` | Another program is using the port: run `TIXLY_DEMO_PORT=5174 npm test`. |
| The run seems to hang before any test starts | A program on the port is accepting connections but not answering. Press Ctrl+C, then run `TIXLY_DEMO_PORT=5174 npm test`. |
| `TIXLY_DEMO_PORT must be a whole number from 1 to 65535` | `TIXLY_DEMO_PORT` is set but empty, `0` or not a port number. Unset it (`unset TIXLY_DEMO_PORT`) to use 4173, or set a port such as `5174`. |
| `TIXLY_BASE_URL must point at this computer` | `TIXLY_BASE_URL` is set to another site. Unset it (`unset TIXLY_BASE_URL`) or point it at `http://127.0.0.1:<port>`. |
| `A lock on data/orders.json was left by a demo app that stopped without removing it` | A demo app was killed outright (or crashed) while running. Make sure none is running, delete `demo-app/data/orders.json.lock`, and run again. |
| The test fails on a check | Open the report with `npx playwright show-report`; the trace and screenshot of the failure are in `test-results/`. |

If none of these fit, run `npx playwright test --reporter=line` and keep the full output for
whoever helps you.
