// The buyer-name check for success evidence (the success-evidence quest, criterion 6: "no evidence
// contains personal data"). It sits beside tools/failure-evidence-check.ts, which looks for
// credentials and the home-folder address; this one looks for buyers' names. Run it from
// participant/tests/playwright:
//   node tools/personal-data-check.ts <folder>              scan the folder
//   node tools/personal-data-check.ts --self-test <folder>  prove the scan finds planted names
//
// SCAN: reads every file in the folder (and its subfolders) as text, UTF-8 or UTF-16, and looks for:
//   - every buyer's name saved in the demo app's orders (demo-app/data/orders.json, read when the
//     check runs, so a name added later is covered too; the file is only read), in any letter case
//     and with any spaces or line breaks between the words (a test's own order there is left to
//     the next item, so it isn't counted twice);
//   - the shape of the names the tests give their own orders: "Test User qa-<8 hex>-<8 hex>"
//     (support/orders-fixture.ts), or just its run-marked part "qa-<8 hex>-<8 hex>".
// Each finding is reported as file, line and kind, never the name itself: the report can be shared.
// A file that isn't text (a picture) can't be read this way, so it is listed to be checked by eye.
// A link, or anything else that isn't a plain file or folder, stops the check: it is not followed.
// Exit 0 when nothing is found, 1 when something is, 2 when it couldn't check everything.
//
// SELF-TEST: copies the folder to a new temporary folder, first scans the untouched copy (it must be
// clean, or nothing is planted and the self-test fails), then plants two names in a new text file
// there: one saved buyer's name, picked at random, and a made-up "Test User qa-…" name, new each
// time. It passes only if each is found at the exact line where it was planted and nothing else is
// found. The temporary copy is deleted afterwards, whatever happens; the folder itself is only read.

import { randomBytes, randomInt } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeText } from "./zip-lite.ts";

type Finding = { file: string; line: number; kind: string };

const args = process.argv.slice(2);
const selfTest = args[0] === "--self-test";
const target = selfTest ? args[1] : args[0];
if (!target || args.length !== (selfTest ? 2 : 1) || (!selfTest && target.startsWith("--"))) {
  console.error("Usage: node tools/personal-data-check.ts [--self-test] <folder>");
  process.exit(2);
}
const folder = resolve(target);

// The saved buyers' names, from the demo app's orders.
const ordersFile = fileURLToPath(new URL("../demo-app/data/orders.json", import.meta.url));
let savedNames: string[];
try {
  const orders: unknown = JSON.parse(readFileSync(ordersFile, "utf8"));
  if (!Array.isArray(orders)) throw new Error("not a list");
  savedNames = [...new Set(orders.map((o) => (o && typeof o === "object" ? (o as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string" && n.trim() !== "")
    .map((n) => n.trim())
    // A test's own order (saved while a run is going, or left over) is covered by the shape below,
    // so it isn't counted twice as a buyer's name.
    .filter((n) => !/qa-[0-9a-f]{8}-[0-9a-f]{8}/i.test(n)))];
} catch (error) {
  console.error(`Couldn't read the saved buyers' names from demo-app/data/orders.json (${(error as Error).message}).`);
  process.exit(2);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name's words, in any letter case, with any spaces or line breaks between them, not inside a
// longer word.
const namePattern = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.split(/\s+/).map(escape).join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
const patterns: [RegExp, string][] = [
  ...savedNames.map((name): [RegExp, string] => [namePattern(name), "a saved buyer's name"]),
  [/Test\s+User\s+qa-[0-9a-f]{8}-[0-9a-f]{8}/gi, "a test order's name (Test User qa-…)"],
  [/(?<!Test\s+User\s+)\bqa-[0-9a-f]{8}-[0-9a-f]{8}\b/gi, "a test order's run-marked name (qa-…)"],
];

class Stop extends Error {}

function scan(root: string): { found: Finding[]; byEye: string[]; files: number } {
  const found: Finding[] = [];
  const byEye: string[] = [];
  let files = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const shown = relative(root, path);
      const kind = lstatSync(path);
      if (kind.isDirectory()) walk(path);
      else if (kind.isFile()) {
        files++;
        const decoded = decodeText(readFileSync(path));
        if (!decoded) {
          byEye.push(shown);
          continue;
        }
        for (const [pattern, what] of patterns) {
          for (const match of decoded.text.matchAll(pattern)) {
            found.push({ file: shown, line: decoded.text.slice(0, match.index).split("\n").length, kind: what });
          }
        }
        // A file's own name could carry a name too.
        for (const [pattern, what] of patterns) {
          if (new RegExp(pattern.source, pattern.flags).test(shown)) found.push({ file: shown, line: 0, kind: `${what}, in the file's name` });
        }
      } else throw new Stop(`${shown} is a link or another special file; it isn't followed, so the check can't vouch for it.`);
    }
  };
  walk(root);
  return { found, byEye, files };
}

function report(result: ReturnType<typeof scan>): void {
  console.log(`Checked ${result.files} file(s) for ${savedNames.length} saved buyer name(s) and the test-name shape.`);
  for (const f of result.found) console.log(`  FOUND ${f.kind}: ${f.file}${f.line ? `, line ${f.line}` : ""}`);
  for (const file of result.byEye) console.log(`  Not text, check by eye: ${file}`);
}

let exitCode = 0;
let copy: string | undefined;
try {
  if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Stop(`${target} isn't a folder.`);
  if (!selfTest) {
    const result = scan(folder);
    report(result);
    exitCode = result.found.length ? 1 : 0;
    console.log(exitCode ? "FAIL: personal data found." : "PASS: no buyer's name found.");
  } else {
    if (savedNames.length === 0) throw new Stop("No saved buyer's names to plant; the self-test can't prove the list is used.");
    copy = mkdtempSync(join(tmpdir(), "personal-data-self-test-"));
    const copyAll = (from: string, to: string) => {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) {
        const path = join(from, name);
        const kind = lstatSync(path);
        if (kind.isDirectory()) copyAll(path, join(to, name));
        else if (kind.isFile()) copyFileSync(path, join(to, name));
        else throw new Stop(`${relative(folder, path)} is a link or another special file; the self-test doesn't copy it.`);
      }
    };
    copyAll(folder, copy);
    const before = scan(copy);
    if (before.found.length) {
      report(before);
      console.log("FAIL: the folder isn't clean before planting, so the self-test can't tell planted names from real ones.");
      exitCode = 1;
    } else {
      const saved = savedNames[randomInt(savedNames.length)];
      const testName = `Test User qa-${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}`;
      const plantFile = "planted-by-self-test.txt";
      writeFileSync(join(copy, plantFile), `A line with nothing in it.\nBought by ${saved}.\nSaved as ${testName}.\n`);
      const after = scan(copy);
      const expected = [
        { file: plantFile, line: 2, kind: "a saved buyer's name" },
        { file: plantFile, line: 3, kind: "a test order's name (Test User qa-…)" },
      ];
      const same = (a: Finding, b: Finding) => a.file === b.file && a.line === b.line && a.kind === b.kind;
      console.log("Planted a saved buyer's name (line 2) and a made-up Test User name (line 3) in a temporary copy.");
      report(after);
      const allFound = expected.every((e) => after.found.some((f) => same(e, f)));
      const nothingElse = after.found.every((f) => expected.some((e) => same(e, f)));
      exitCode = allFound && nothingElse ? 0 : 1;
      console.log(exitCode ? "FAIL: the check missed a planted name or found something else." : "PASS: both planted names were found, at the right lines, and nothing else.");
    }
  }
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(error.message);
  exitCode = 2;
} finally {
  if (copy) rmSync(copy, { recursive: true, force: true });
}
process.exit(exitCode);
