// Checks every test's tags against the tag scheme, for the tagging quest.
//
// The vocabulary is read from the scheme page itself (participant/context/playwright/tag-scheme.md),
// so the page and the check can't disagree: each "## N. <Dimension>" section's table lists that
// dimension's tags, the "## Suite" section lists the optional suite tags, and the duration table
// gives each duration tag's limit in seconds. The tests and their tags come from Playwright itself
// (`npx playwright test --list`), so every test counts, including those normally skipped.
//
// For every test it reports, by name and file:
//   - a dimension with no tag, or with more than one;
//   - more than one suite tag;
//   - any tag that isn't in the scheme.
// Given a Playwright JSON report of a real run (--results <file>), it also compares each test's own
// duration with its duration tag's limit and names every test that ran over; a test that didn't run
// (skipped) is listed as not timed.
//
// Run it from participant/tests/playwright:
//   node tools/tagging-check.ts                          (tags only)
//   PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/run.json npx playwright test --reporter=json
//   node tools/tagging-check.ts --results /tmp/run.json  (tags and durations)
// It ends with PASS (exit 0) or FAIL (exit 1); 2 means it couldn't run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Test = { title: string; file: string; line: number; tags: string[]; duration?: number; status?: string };
type Suite = { specs?: { title: string; file: string; line: number; tags?: string[]; tests: { results?: { duration: number; status: string }[] }[] }[]; suites?: Suite[] };

const args = process.argv.slice(2);
const resultsFlag = args.indexOf("--results");
const resultsFile = resultsFlag === -1 ? undefined : args[resultsFlag + 1];
if (resultsFlag !== -1 && !resultsFile) {
  console.error("--results needs the path of a Playwright JSON report.");
  process.exit(2);
}
const schemeFlag = args.indexOf("--scheme");
const schemeFile =
  schemeFlag === -1 ? fileURLToPath(new URL("../../../context/playwright/tag-scheme.md", import.meta.url)) : resolve(args[schemeFlag + 1] ?? "");

// --- The vocabulary, from the scheme page. ---------------------------------------------------
if (!existsSync(schemeFile)) {
  console.error(`The tag scheme isn't at ${schemeFile}.`);
  process.exit(2);
}
const scheme = readFileSync(schemeFile, "utf8");
const dimensions = new Map<string, Set<string>>();
const suiteTags = new Set<string>();
const limits = new Map<string, number>();
let section = "";
for (const line of scheme.split("\n")) {
  const heading = /^## (?:\d+\. )?([A-Za-z ]+?)(?::| \(|$)/.exec(line);
  if (heading) {
    section = heading[1].trim();
    continue;
  }
  if (!section) continue;
  const tags = [...line.matchAll(/`@([a-z0-9-]+)`/g)].map((m) => m[1]);
  if (section === "Suite") {
    for (const tag of tags) {
      if ([...dimensions.values()].some((known) => known.has(tag))) {
        console.error(`The scheme lists @${tag} as a suite tag and in a dimension; each tag must belong to exactly one group.`);
        process.exit(2);
      }
      suiteTags.add(tag);
    }
  } else if (line.startsWith("| `@")) {
    // The first cell of a table row is the tag it defines.
    const tag = tags[0];
    if ([...dimensions.values()].some((known) => known.has(tag)) || suiteTags.has(tag)) {
      console.error(`The scheme lists @${tag} more than once; each tag must belong to exactly one dimension.`);
      process.exit(2);
    }
    if (!dimensions.has(section)) dimensions.set(section, new Set());
    dimensions.get(section)?.add(tag);
    const limit = /^\| `@[a-z0-9-]+` \| (\d+) seconds?/.exec(line);
    if (limit) limits.set(tag, Number(limit[1]));
  }
}
const allTags = new Map<string, string>(); // tag -> its dimension (or "Suite")
for (const [dimension, tags] of dimensions) for (const tag of tags) allTags.set(tag, dimension);
for (const tag of suiteTags) allTags.set(tag, "Suite");
const expected = ["Feature", "Risk", "Read or write", "Layer", "Duration"];
const missingDimensions = expected.filter((dimension) => !dimensions.has(dimension));
if (missingDimensions.length > 0 || dimensions.size !== expected.length) {
  console.error(`The scheme should define exactly these dimensions: ${expected.join(", ")}; found: ${[...dimensions.keys()].join(", ")}.`);
  process.exit(2);
}
const unlimited = [...(dimensions.get("Duration") ?? [])].filter((tag) => !limits.has(tag));
if (unlimited.length > 0) {
  console.error(`Every duration tag needs a limit in the scheme; none for: ${unlimited.map((t) => `@${t}`).join(", ")}.`);
  process.exit(2);
}

// --- The tests, from Playwright. ---------------------------------------------------------------
const listed = spawnSync("npx", ["playwright", "test", "--list", "--reporter=json"], { encoding: "utf8" });
if (listed.error || listed.status !== 0) {
  console.error(`Couldn't list the tests:\n${listed.error ? listed.error.message : `${listed.stdout ?? ""}${listed.stderr ?? ""}`}`);
  process.exit(2);
}
const collect = (suite: Suite, into: Test[]) => {
  for (const spec of suite.specs ?? []) into.push({ title: spec.title, file: spec.file, line: spec.line, tags: spec.tags ?? [] });
  for (const child of suite.suites ?? []) collect(child, into);
};
const tests: Test[] = [];
for (const suite of (JSON.parse(listed.stdout).suites ?? []) as Suite[]) collect(suite, tests);
tests.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

// --- Durations, from a real run. --------------------------------------------------------------
if (resultsFile) {
  if (!existsSync(resultsFile)) {
    console.error(`No Playwright report at ${resultsFile}.`);
    process.exit(2);
  }
  const ran: Test[] = [];
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      const result = spec.tests[0]?.results?.at(-1);
      ran.push({ title: spec.title, file: spec.file, line: spec.line, tags: [], duration: result?.duration, status: result?.status });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (JSON.parse(readFileSync(resultsFile, "utf8")).suites ?? []) as Suite[]) walk(suite);
  for (const test of tests) {
    const match = ran.find((r) => r.file === test.file && r.line === test.line && r.title === test.title);
    if (match) Object.assign(test, { duration: match.duration, status: match.status });
  }
}

// --- The checks. -------------------------------------------------------------------------------
let problems = 0;
const timed: string[] = [];
console.log(`Scheme: ${[...dimensions].map(([d, t]) => `${d} (${[...t].map((x) => `@${x}`).join(" ")})`).join("; ")}; suite (optional): ${[...suiteTags].map((x) => `@${x}`).join(" ")}.`);
console.log(`Duration limits: ${[...limits].map(([t, s]) => `@${t} ${s} s`).join(", ")}.`);
console.log(`Tests found: ${tests.length}.\n`);
for (const test of tests) {
  const where = `${test.file}:${test.line} "${test.title}"`;
  const issues: string[] = [];
  for (const tag of test.tags) if (!allTags.has(tag)) issues.push(`unknown tag @${tag} (not in the scheme)`);
  for (const dimension of expected) {
    const found = test.tags.filter((tag) => allTags.get(tag) === dimension);
    if (found.length === 0) issues.push(`no ${dimension.toLowerCase()} tag`);
    if (found.length > 1) issues.push(`more than one ${dimension.toLowerCase()} tag (${found.map((t) => `@${t}`).join(", ")})`);
  }
  const suites = test.tags.filter((tag) => allTags.get(tag) === "Suite");
  if (suites.length > 1) issues.push(`more than one suite tag (${suites.map((t) => `@${t}`).join(", ")})`);
  const durationTag = test.tags.find((tag) => allTags.get(tag) === "Duration");
  if (resultsFile && durationTag) {
    const limit = limits.get(durationTag) ?? 0;
    if (test.duration === undefined || test.status === "skipped") {
      timed.push(`  not run, so not timed: ${where}`);
    } else if (test.duration > limit * 1000) {
      issues.push(`took ${(test.duration / 1000).toFixed(2)} s, over the ${limit} s limit of @${durationTag}`);
    } else {
      timed.push(`  ${(test.duration / 1000).toFixed(2)} s within @${durationTag} (${limit} s): ${where}`);
    }
  }
  if (issues.length > 0) {
    problems += issues.length;
    console.log(`PROBLEM ${where}`);
    for (const issue of issues) console.log(`  - ${issue}`);
  } else {
    console.log(`ok      ${where}  ${test.tags.map((t) => `@${t}`).join(" ")}`);
  }
}
if (resultsFile) {
  console.log(`\nDurations (from ${resultsFile.split("/").pop()}):`);
  for (const line of timed) console.log(line);
}
console.log(problems === 0 ? `\nPASS: all ${tests.length} tests carry one tag from each dimension and only tags from the scheme${resultsFile ? ", and none ran over its duration limit" : ""}.`
  : `\nFAIL: ${problems} problem(s) in the tests above.`);
process.exit(problems === 0 ? 0 : 1);
