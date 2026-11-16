// Copies one failing test's evidence out of test-results/ on purpose (the failure-evidence quest:
// test-results/ is emptied at the start of every run, so a bundle that should outlive the next run is
// copied out), and hides the computer's home-folder address on the way. Nothing is changed in
// test-results/.
//
// Run it from participant/tests/playwright:
//   node tools/copy-failure-bundle.ts <the test's folder in test-results> <a new or empty folder>
//
// What it changes in the copy:
//   - In every text file, and in every text member of trace.zip, the home-folder address (for example
//     /Users/<name>) becomes ~, so the bundle doesn't show the computer's user name.
//   - Inside trace.zip, src/ holds a copy of each test file named by the sha1 of its full address; the
//     trace viewer finds a file's source by that name. Each one is renamed to the sha1 of the
//     shortened address, so the viewer's Source tab still works (and the old name, which could
//     confirm a guessed user name, is gone).
// Images (the screenshot, the trace's page snapshots) are copied as they are: check them by eye.
// It reports how many places it changed, never the addresses themselves. Then scan the copy:
//   node tools/failure-evidence-check.ts <the copy>

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { asText, readZip, writeZip } from "./zip-lite.ts";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("Usage: node tools/copy-failure-bundle.ts <the test's folder in test-results> <a new or empty folder>");
  process.exit(2);
}
const source = resolve(from);
const target = resolve(to);
if (!existsSync(join(source, "trace.zip"))) {
  console.error(`${from} has no trace.zip: give the folder of one failing test, inside test-results/.`);
  process.exit(2);
}
if (target === source || target.startsWith(`${source}/`) || source.startsWith(`${target}/`)) {
  console.error("The copy and the original can't be inside each other.");
  process.exit(2);
}
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${to} isn't empty; give a new or empty folder, so nothing there is overwritten.`);
  process.exit(2);
}

const home = homedir();
if (home.length < 2) {
  console.error("Couldn't tell which folder is the home folder, so nothing would be hidden.");
  process.exit(1);
}
const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const shorten = (text: string) => text.replaceAll(home, "~");
const places = (text: string) => text.split(home).length - 1;

let changed = 0;
const report: string[] = [];

function copyTrace(zip: Buffer): Buffer {
  const entries = readZip(zip);
  // Every full address in the trace that starts in the home folder, by the sha1 the viewer uses.
  const renames = new Map<string, string>();
  const addressPattern = new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"\\s:)]*`, "g");
  for (const { data } of entries) {
    const text = asText(data);
    for (const address of text?.match(addressPattern) ?? []) renames.set(sha1(address), sha1(shorten(address)));
  }
  let members = 0;
  let renamed = 0;
  const copied = entries.map(({ name, data }) => {
    let newName = name;
    const sourceFile = /^src\/([0-9a-f]{40})(\.[^/]*)?$/.exec(name);
    if (sourceFile && renames.has(sourceFile[1])) {
      newName = `src/${renames.get(sourceFile[1])}${sourceFile[2] ?? ""}`;
      renamed++;
    }
    const text = asText(data);
    if (text === null || places(text) === 0) return { name: newName, data };
    members++;
    changed += places(text);
    return { name: newName, data: Buffer.from(shorten(text), "utf8") };
  });
  report.push(`  trace.zip: ${members} member(s) changed, ${renamed} source file(s) renamed in src/`);
  return writeZip(copied);
}

function copy(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    const path = join(from, name);
    const out = join(to, name);
    if (statSync(path).isDirectory()) {
      copy(path, out);
      continue;
    }
    const data = readFileSync(path);
    const shown = relative(source, path);
    if (name.endsWith(".zip")) {
      writeFileSync(out, copyTrace(data));
      continue;
    }
    const text = asText(data);
    if (text === null) {
      writeFileSync(out, data);
      report.push(`  ${shown}: copied as it is (not text: check it by eye)`);
      continue;
    }
    const count = places(text);
    changed += count;
    writeFileSync(out, shorten(text));
    if (count > 0) report.push(`  ${shown}: ${count} place(s) changed`);
  }
}

copy(source, target);
const shownPath = (path: string) => (relative(process.cwd(), path).startsWith("..") ? path : relative(process.cwd(), path));
console.log(`Copied ${shownPath(source)} to ${shownPath(target)}.`);
console.log(`The home-folder address was replaced with ~ in ${changed} place(s):`);
for (const line of report) console.log(line);
