// Runs Playwright tests one at a time in a chosen order, for the data-isolation quest: forward (as
// written), reversed, or random. Playwright itself always runs a file's tests top to bottom, so
// this asks Playwright for the list of tests, puts them in the chosen order, and runs each one on
// its own in that order. A test that only passes after another one has run is caught out.
//
// For a random order it prints the seed (the number the shuffle came from); giving the same seed
// again repeats exactly the same order, so a failure seen in a random order can be reproduced.
//
// Run it from participant/tests/playwright:
//   node tools/run-in-order.ts forward isolated.spec.ts
//   node tools/run-in-order.ts reversed coupled.spec.ts
//   node tools/run-in-order.ts random isolated.spec.ts            (a new seed each time)
//   node tools/run-in-order.ts random isolated.spec.ts --seed 1234 (the same order as before)
// It exits with 0 only if every test passed.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

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

// One run marker for the whole ordered run (see support/global-setup.ts), so every order these
// tests create carries the same marker even though each test is started separately.
const marker = process.env.TIXLY_RUN_MARKER ?? `qa-${randomBytes(3).toString("hex")}`;
console.log(`Run marker: ${marker}\n`);

let failed = 0;
ordered.forEach((test, i) => {
  // file:line runs exactly that one test.
  const run = spawnSync(
    "npx",
    ["playwright", "test", `${test.file}:${test.line}`, "--workers=1", "--reporter=line"],
    { encoding: "utf8", env: { ...process.env, TIXLY_RUN_MARKER: marker } },
  );
  const passed = run.status === 0;
  if (!passed) failed++;
  console.log(`${i + 1}. ${passed ? "PASSED" : "FAILED"}  ${test.title}`);
  if (!passed) {
    const details = `${run.stdout}${run.stderr}`
      .split("\n")
      .filter((line) => /Error:|Expected|Received|waiting for|locator\./.test(line))
      .slice(0, 4)
      .map((line) => `     ${line.trim()}`);
    console.log(details.join("\n"));
  }
});
console.log(`\n${ordered.length - failed} passed, ${failed} failed, in ${order} order.`);
process.exit(failed === 0 ? 0 : 1);
