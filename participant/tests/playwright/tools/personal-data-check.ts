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
//     and with any spaces or line breaks between the words. A name in exactly the tests' own form
//     ("Test User qa-…", below) is left to the next item, so it isn't counted twice;
//   - the shape of the names the tests give their own orders: "Test User qa-<8 hex>-<8 hex>"
//     (support/orders-fixture.ts), or just its run-marked part "qa-<8 hex>-<8 hex>", even next to
//     an underscore or other punctuation.
// JSON and JSON Lines files are also checked by each string's real value, after escapes such as
//  , at the line where the string starts. Every entry's own name is checked too: each file,
// picture and folder, even an empty one.
// Each finding is reported as file, line and kind, never the name itself, and every path it prints
// has any name it found replaced with <name>: the report can be shared. A file that isn't text (a
// picture) can't be read this way, so it is listed to be checked by eye. A link, or anything else
// that isn't a plain file or folder, stops the check: it is not followed. So does a file or folder
// it can't read, reported by its path and the kind of error only.
// Exit 0 when nothing is found, 1 when something is, 2 when it couldn't check everything.
//
// SELF-TEST: copies the folder to a new temporary folder (never inside the folder itself), first
// scans the untouched copy (it must be clean, or nothing is planted and the self-test fails), then
// plants, in a new text file there, every saved buyer's name (one per line),
// a made-up "Test User qa-…" name and, on a line of its own, a made-up bare "qa-…" marker; the
// made-up ones are new each time. It passes only if each is found at the exact line where it was
// planted, as the right kind, and nothing else is found. The temporary copy is deleted afterwards,
// whatever happens; the folder itself is only read.

import { randomBytes } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonDocuments, jsonStrings } from "./json-places.ts";
import { decodeText } from "./zip-lite.ts";

type Finding = { file: string; line: number; kind: string };

// A stop that means "couldn't check everything" (exit 2). Its message never carries a raw system
// error, which can hold a full path.
class Stop extends Error {}
const errorKind = (error: unknown) => (error as { code?: unknown })?.code ?? "an unexpected error";

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
const TEST_NAME = /^Test\s+User\s+qa-[0-9a-f]{8}-[0-9a-f]{8}$/i;
let savedNames: string[];
try {
  const orders: unknown = JSON.parse(readFileSync(ordersFile, "utf8"));
  if (!Array.isArray(orders)) throw new Error();
  savedNames = [...new Set(orders.map((o) => (o && typeof o === "object" ? (o as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string" && n.trim() !== "")
    .map((n) => n.trim())
    .filter((n) => !TEST_NAME.test(n)))];
} catch {
  console.error("Couldn't read the saved buyers' names from demo-app/data/orders.json: it must be there, readable, and a JSON list of orders.");
  process.exit(2);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Not inside a longer word or number (an underscore counts as a boundary).
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";
const KIND_SAVED = "a saved buyer's name";
const KIND_TEST = "a test order's name (Test User qa-…)";
const KIND_MARKER = "a test order's run-marked name (qa-…)";
const patterns: [RegExp, string][] = [
  ...savedNames.map((name): [RegExp, string] => [
    new RegExp(`${NOT_WORD_BEFORE}${name.split(/\s+/).map(escape).join("\\s+")}${NOT_WORD_AFTER}`, "giu"),
    KIND_SAVED,
  ]),
  [new RegExp(`${NOT_WORD_BEFORE}Test\\s+User\\s+qa-[0-9a-f]{8}-[0-9a-f]{8}${NOT_WORD_AFTER}`, "giu"), KIND_TEST],
  [new RegExp(`(?<!Test\\s+User\\s+)${NOT_WORD_BEFORE}qa-[0-9a-f]{8}-[0-9a-f]{8}${NOT_WORD_AFTER}`, "giu"), KIND_MARKER],
];
const matches = (text: string) => patterns.flatMap(([pattern, kind]) => [...text.matchAll(pattern)].map((m) => ({ index: m.index, kind })));
// A path as it may be printed: any name found in it replaced with <name>.
const shown = (path: string) => patterns.reduce((text, [pattern]) => text.replace(pattern, "<name>"), path);

function scan(root: string): { found: Finding[]; byEye: string[]; files: number } {
  const found: Finding[] = [];
  const byEye: string[] = [];
  let files = 0;
  const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (error) {
      throw new Stop(`Couldn't list ${shown(relative(root, dir) || ".")} (${errorKind(error)}).`);
    }
    for (const name of names) {
      const path = join(dir, name);
      const where = relative(root, path);
      // Every entry's own name first, whatever it is.
      for (const { kind } of matches(name)) found.push({ file: shown(where), line: 0, kind: `${kind}, in the name` });
      let kind;
      try {
        kind = lstatSync(path);
      } catch (error) {
        throw new Stop(`Couldn't look at ${shown(where)} (${errorKind(error)}).`);
      }
      if (kind.isDirectory()) walk(path);
      else if (kind.isFile()) {
        files++;
        let data: Buffer;
        try {
          data = readFileSync(path);
        } catch (error) {
          throw new Stop(`Couldn't read ${shown(where)} (${errorKind(error)}).`);
        }
        const decoded = decodeText(data);
        if (!decoded) {
          byEye.push(shown(where));
          continue;
        }
        const text = decoded.text;
        const here = new Set<string>();
        const add = (line: number, what: string) => {
          const key = `${line}\u0000${what}`;
          if (here.has(key)) return;
          here.add(key);
          found.push({ file: shown(where), line, kind: what });
        };
        for (const { index, kind: what } of matches(text)) add(lineAt(text, index), what);
        // JSON strings by their real values (escapes undone), at the line where each starts. A
        // file that isn't JSON gives no documents.
        let documents: ReturnType<typeof jsonDocuments> = [];
        try {
          documents = jsonDocuments(text);
        } catch {
          documents = [];
        }
        for (const { node, offset } of documents) {
          for (const s of jsonStrings(node)) {
            for (const { kind: what } of matches(s.value)) add(lineAt(text, offset + s.start), what);
          }
        }
      } else throw new Stop(`${shown(where)} is a link or another special file; it isn't followed, so the check can't vouch for it.`);
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

// Is one folder the other, or inside it?
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

let exitCode = 0;
let copy: string | undefined;
try {
  if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Stop("The path given isn't a folder.");
  if (!selfTest) {
    const result = scan(folder);
    report(result);
    exitCode = result.found.length ? 1 : 0;
    console.log(exitCode ? "FAIL: personal data found." : "PASS: no buyer's name found.");
  } else {
    const realFolder = realpathSync(folder);
    const tempParent = realpathSync(tmpdir());
    // The copy goes in a new folder under the temporary folder, so that must not be the folder being
    // checked or inside it: the copy would then copy itself, without end.
    if (within(tempParent, realFolder)) {
      throw new Stop("The temporary folder for the copy would be inside the folder being checked; set TMPDIR elsewhere.");
    }
    copy = mkdtempSync(join(tempParent, "personal-data-self-test-"));
    const copyAll = (from: string, to: string) => {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) {
        const path = join(from, name);
        const kind = lstatSync(path);
        if (kind.isDirectory()) copyAll(path, join(to, name));
        else if (kind.isFile()) copyFileSync(path, join(to, name));
        else throw new Stop(`${shown(relative(folder, path))} is a link or another special file; the self-test doesn't copy it.`);
      }
    };
    try {
      copyAll(realFolder, copy);
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop(`Couldn't copy the folder for the self-test (${errorKind(error)}).`);
    }
    const before = scan(copy);
    if (before.found.length) {
      report(before);
      console.log("FAIL: the folder isn't clean before planting, so the self-test can't tell planted names from real ones.");
      exitCode = 1;
    } else {
      const hex = () => randomBytes(4).toString("hex");
      const lines = ["A line with nothing in it."];
      const expected: Finding[] = [];
      const plantFile = "planted-by-self-test.txt";
      const plant = (text: string, kind: string) => {
        lines.push(text);
        expected.push({ file: plantFile, line: lines.length, kind });
      };
      for (const name of savedNames) plant(`Bought by ${name}.`, KIND_SAVED);
      plant(`Saved as Test User qa-${hex()}-${hex()}.`, KIND_TEST);
      plant(`Marked qa-${hex()}-${hex()}_values.`, KIND_MARKER);
      writeFileSync(join(copy, plantFile), `${lines.join("\n")}\n`);
      const after = scan(copy);
      console.log(`Planted every saved buyer's name (${savedNames.length}), a made-up Test User name and a made-up bare qa- marker, one per line, in a temporary copy.`);
      report(after);
      const same = (a: Finding, b: Finding) => a.file === b.file && a.line === b.line && a.kind === b.kind;
      const allFound = expected.every((e) => after.found.some((f) => same(e, f)));
      const nothingElse = after.found.every((f) => expected.some((e) => same(e, f)));
      exitCode = allFound && nothingElse ? 0 : 1;
      console.log(exitCode
        ? "FAIL: the check missed a planted name or found something else."
        : `PASS: all ${expected.length} planted names were found, each at its line and as its kind, and nothing else.`);
    }
  }
} catch (error) {
  console.error(error instanceof Stop ? error.message : `The check couldn't finish (${errorKind(error)}).`);
  exitCode = 2;
} finally {
  if (copy) rmSync(copy, { recursive: true, force: true });
}
process.exit(exitCode);
