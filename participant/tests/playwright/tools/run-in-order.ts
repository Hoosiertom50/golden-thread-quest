// Runs Playwright tests one at a time in a chosen order, for the data-isolation quest: forward (as
// written), reversed, or random. Playwright itself always runs a file's tests top to bottom, so
// this asks Playwright for the list of tests, puts them in the chosen order, and runs each one on
// its own in that order. A test that only passes after another one has run is caught out.
//
// For a random order it prints the seed (the number the shuffle came from); giving the same seed
// again repeats exactly the same order, so a failure seen in a random order can be reproduced.
//
// The whole ordered run behaves like one normal run: one copy of the demo app (started here,
// unless TIXLY_BASE_URL points at one already running), one run marker for every test, and the
// run-end safety net (support/global-teardown.ts) once, after the last test, not after each one.
// Each test's own result is read from Playwright's report, so a skipped test is shown as SKIPPED,
// not counted as a pass.
//
// Run it from participant/tests/playwright:
//   node tools/run-in-order.ts forward isolated.spec.ts
//   node tools/run-in-order.ts reversed coupled.spec.ts
//   node tools/run-in-order.ts random isolated.spec.ts            (a new seed each time)
//   node tools/run-in-order.ts random isolated.spec.ts --seed 1234 (the same order as before)
// It exits with 0 only if every test ran and passed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Order = "forward" | "reversed" | "random";
type Listed = { file: string; line: number; title: string };

const usage = "Usage: node tools/run-in-order.ts forward|reversed|random <test files...> [--seed <whole number>]";
const args = process.argv.slice(2);
const order = args.shift() as Order;
let seed: number | undefined;
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--seed") {
    const value = args[++i] ?? "";
    if (!/^[0-9]{1,9}$/.test(value)) {
      console.error(`${usage}\nThe seed must be a whole number of up to 9 digits.`);
      process.exit(2);
    }
    seed = Number(value);
  } else {
    files.push(args[i]);
  }
}
if (!["forward", "reversed", "random"].includes(order) || files.length === 0) {
  console.error(usage);
  process.exit(2);
}
if (seed !== undefined && order !== "random") {
  console.error(`${usage}\nA seed only applies to a random order.`);
  process.exit(2);
}

// The tests in the files, as Playwright lists them, in the order they are written.
function listTests(): Listed[] {
  const listed = spawnSync("npx", ["playwright", "test", ...files, "--list", "--reporter=json"], {
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    console.error(`Couldn't list the tests:\n${listed.stdout}${listed.stderr}`);
    process.exit(2);
  }
  const found: Listed[] = [];
  const walk = (suite: { specs?: { file: string; line: number; title: string }[]; suites?: unknown[] }) => {
    for (const spec of suite.specs ?? []) found.push({ file: spec.file, line: spec.line, title: spec.title });
    for (const child of (suite.suites ?? []) as (typeof suite)[]) walk(child);
  };
  for (const suite of JSON.parse(listed.stdout).suites ?? []) walk(suite);
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// A small, repeatable shuffle: the same seed always gives the same order.
function shuffled<T>(items: T[], startSeed: number): T[] {
  let state = startSeed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const tests = listTests();
if (tests.length === 0) {
  console.error(`No tests found in: ${files.join(", ")}`);
  process.exit(2);
}
let ordered = tests;
if (order === "reversed") ordered = [...tests].reverse();
if (order === "random") {
  seed ??= Math.floor(Math.random() * 1_000_000_000);
  ordered = shuffled(tests, seed);
}

console.log(`Order: ${order}${order === "random" ? ` (seed ${seed}; repeat with --seed ${seed})` : ""}`);
ordered.forEach((test, i) => console.log(`  ${i + 1}. ${test.title}`));
console.log("");

// One run marker and one copy of the demo app for the whole ordered run.
const marker = process.env.TIXLY_RUN_MARKER ?? `qa-${randomBytes(4).toString("hex")}`;
let base = process.env.TIXLY_BASE_URL;
let server: ChildProcess | undefined;
if (base === undefined) {
  const port = process.env.TIXLY_DEMO_PORT ?? "4173";
  server = spawn("node", ["demo-app/server.js"], { env: { ...process.env, TIXLY_DEMO_PORT: port }, stdio: "ignore" });
  base = `http://127.0.0.1:${port}`;
  await waitForApp(base);
}
// The orders that exist before the first test, which the safety net must never touch.
process.env.TIXLY_BASE_URL = base;
const { existingOrderIds } = await import("../support/global-setup.ts");
const preexisting = process.env.TIXLY_PREEXISTING_IDS ?? JSON.stringify(await existingOrderIds());
if (server) delete process.env.TIXLY_BASE_URL;
console.log(`Run marker: ${marker}\n`);

async function waitForApp(address: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      // The answer is read to the end, so the connection isn't left idle for a later request.
      await (await fetch(address)).arrayBuffer();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.error(`The demo app didn't start at ${address}.`);
  process.exit(2);
}

// The result Playwright recorded for the one test in a run: passed, failed, timedOut or skipped.
function resultOf(reportFile: string): string {
  if (!existsSync(reportFile)) return "failed";
  const statuses: string[] = [];
  const walk = (suite: { specs?: { tests?: { results?: { status: string }[] }[] }[]; suites?: unknown[] }) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) statuses.push(test.results?.at(-1)?.status ?? "skipped");
    }
    for (const child of (suite.suites ?? []) as (typeof suite)[]) walk(child);
  };
  for (const suite of JSON.parse(readFileSync(reportFile, "utf8")).suites ?? []) walk(suite);
  return statuses.length === 1 ? statuses[0] : "failed";
}

const reportFile = join(tmpdir(), `run-in-order-${process.pid}.json`);
const counts = { passed: 0, failed: 0, skipped: 0 };
try {
  ordered.forEach((test, i) => {
    rmSync(reportFile, { force: true });
    // file:line runs exactly that one test, against the shared copy of the app; the safety net
    // waits until the end (TIXLY_SAFETY_NET_LATER).
    const run = spawnSync(
      "npx",
      ["playwright", "test", `${test.file}:${test.line}`, "--workers=1", "--reporter=line,json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TIXLY_RUN_MARKER: marker,
          TIXLY_BASE_URL: base,
          TIXLY_SAFETY_NET_LATER: "1",
          TIXLY_PREEXISTING_IDS: preexisting,
          PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
        },
      },
    );
    const status = run.status === 0 || run.status === 1 ? resultOf(reportFile) : "failed";
    const shown = status === "passed" ? "PASSED" : status === "skipped" ? "SKIPPED" : "FAILED";
    counts[status === "passed" ? "passed" : status === "skipped" ? "skipped" : "failed"]++;
    console.log(`${i + 1}. ${shown}  ${test.title}`);
    if (shown === "FAILED") {
      const details = `${run.stdout}${run.stderr}`
        .split("\n")
        .filter((line) => /Error:|Expected|Received|waiting for|locator\./.test(line))
        .slice(0, 4)
        .map((line) => `     ${line.trim()}`);
      console.log(details.join("\n"));
    }
  });
  // The safety net, once, after the last test.
  process.env.TIXLY_RUN_MARKER = marker;
  process.env.TIXLY_BASE_URL = base;
  process.env.TIXLY_PREEXISTING_IDS = preexisting;
  delete process.env.TIXLY_SAFETY_NET_LATER;
  const { default: safetyNet } = await import("../support/global-teardown.ts");
  await safetyNet();
} finally {
  rmSync(reportFile, { force: true });
  server?.kill();
}
console.log(`\n${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, in ${order} order.`);
if (counts.skipped > 0) console.log("A skipped test didn't run, so it isn't counted as passing (see its file for how to turn it on).");
process.exit(counts.failed === 0 && counts.skipped === 0 ? 0 : 1);
