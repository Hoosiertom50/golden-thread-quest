// The secret check for a failure bundle (the failure-evidence quest, criteria 3 and 4). Run it from
// participant/tests/playwright, with the run's API key in TIXLY_API_KEY (the same made-up key the
// tests used):
//   node tools/failure-evidence-check.ts <bundle folder>              scan the bundle
//   node tools/failure-evidence-check.ts --self-test <bundle folder>  prove the scan finds planted fakes
//
// SCAN: reads every file in the folder and every member of every .zip in it (trace.zip), and looks
// for:
//   - the run's actual API key, as it is, URL-encoded or base64-encoded;
//   - the shapes of secrets: a bearer token, a JSON web token, an Authorization, Cookie, Set-Cookie or
//     API-key header with a value, a password, secret, token or key given a value, a private key,
//     a password inside an address (user:password@), and the prefixes of well-known token kinds;
//   - the computer's home-folder address, which shows its user name (a personal detail, not a secret:
//     the bundle is meant to have it replaced with ~ by tools/copy-failure-bundle.ts).
// Each finding is reported as file (and zip member), line and kind, never the value, so the report
// itself can be shared. Files that aren't text (the screenshot, the trace's page images) are still
// searched for the key and the home-folder address, and are listed to be checked by eye for
// personal data. Exit 0 when nothing is found, 1 when something is, 2 when it couldn't check.
//
// SELF-TEST: copies the bundle to a new temporary folder, plants three fake values there (a made-up
// bearer token in console.txt, a made-up session cookie inside trace.zip, and the run's API key in
// error.txt), scans the copy and passes only if each one is found at the exact file and line where it
// was planted and nothing else is found. The fakes are made up at random each time, so none is ever
// written into a file that could be committed. The temporary copy is deleted afterwards; the bundle
// itself is only read.

import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { asText, readZip, writeZip } from "./zip-lite.ts";

type Finding = { place: string; line: number | null; kind: string };

const args = process.argv.slice(2);
const selfTest = args[0] === "--self-test";
const folderArg = selfTest ? args[1] : args[0];
if (!folderArg || args.length !== (selfTest ? 2 : 1)) {
  console.error("Usage: node tools/failure-evidence-check.ts [--self-test] <bundle folder>");
  process.exit(2);
}
const apiKey = process.env.TIXLY_API_KEY ?? "";
if (!/^[\x21-\x7e]{8,256}$/.test(apiKey)) {
  console.error("TIXLY_API_KEY must hold the run's API key (8 to 256 visible characters), so the scan can look for it.");
  process.exit(2);
}
const home = homedir();
if (home.length < 2) {
  console.error("Couldn't tell which folder is the home folder, so it couldn't be looked for.");
  process.exit(2);
}

// The exact values this run must never leave behind, in the forms they could be stored in.
const exactValues: [string, string][] = [
  [apiKey, "the run's API key"],
  [encodeURIComponent(apiKey), "the run's API key (URL-encoded)"],
  [Buffer.from(apiKey).toString("base64"), "the run's API key (base64)"],
  [home, "the home-folder address (shows the user name)"],
  [encodeURIComponent(home), "the home-folder address (URL-encoded)"],
];

// The shapes of secrets. Each is tested on one line at a time.
const shapes: [RegExp, string][] = [
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i, "a bearer token"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a JSON web token"],
  // A header written as text ("Cookie: ...") or as Playwright stores it ({"name":"Cookie","value":"..."}).
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-[a-z-]*(api-key|token|secret))\s*:\s*\S/i, "a credential header with a value"],
  [/"name"\s*:\s*"(authorization|proxy-authorization|cookie|set-cookie|x-[a-z-]*(api-key|token|secret))"\s*,\s*"value"\s*:\s*"[^"]/i, "a credential header with a value"],
  [/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|session[_-]?id)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_.~-]{8,}/i, "a password, secret, token or key with a value"],
  // Built from two parts so this file doesn't itself look like a private key to a credential scanner.
  [new RegExp(["-----BEGIN[A-Z ]*PRIVATE", "KEY-----"].join(" ")), "a private key"],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i, "a password inside an address"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{20,})/, "a well-known token kind"],
];

function scanText(text: string, place: string, found: Finding[]): void {
  text.split(/\r?\n/).forEach((line, index) => {
    const kinds = new Set<string>();
    for (const [value, kind] of exactValues) if (line.includes(value)) kinds.add(kind);
    for (const [shape, kind] of shapes) if (shape.test(line)) kinds.add(kind);
    for (const kind of kinds) found.push({ place, line: index + 1, kind });
  });
}

// Not text: no lines to report, but the exact values are still looked for, byte for byte.
function scanBytes(data: Buffer, place: string, found: Finding[], byEye: string[]): void {
  for (const [value, kind] of exactValues) if (data.includes(Buffer.from(value))) found.push({ place, line: null, kind });
  byEye.push(place);
}

function scanFile(data: Buffer, place: string, found: Finding[], byEye: string[], counts: { files: number; members: number }): void {
  if (place.endsWith(".zip")) {
    for (const member of readZip(data)) {
      counts.members++;
      const memberPlace = `${place} › ${member.name}`;
      const text = asText(member.data);
      if (text === null) scanBytes(member.data, memberPlace, found, byEye);
      else scanText(text, memberPlace, found);
    }
    return;
  }
  const text = asText(data);
  if (text === null) scanBytes(data, place, found, byEye);
  else scanText(text, place, found);
}

function scan(folder: string): { found: Finding[]; byEye: string[]; counts: { files: number; members: number } } {
  const found: Finding[] = [];
  const byEye: string[] = [];
  const counts = { files: 0, members: 0 };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        counts.files++;
        scanFile(readFileSync(path), relative(folder, path), found, byEye, counts);
      }
    }
  };
  walk(folder);
  return { found, byEye, counts };
}

const shown = (f: Finding) => `${f.place}${f.line === null ? "" : `:${f.line}`}  ${f.kind}`;

const folder = resolve(folderArg);
try {
  if (!statSync(folder).isDirectory()) throw new Error("not a folder");
} catch {
  console.error(`${folderArg} isn't a folder.`);
  process.exit(2);
}

// A file the check can't read (a damaged zip, say) stops it with exit 2: never a silent pass.
function scanOrStop(target: string): ReturnType<typeof scan> {
  try {
    return scan(target);
  } catch (error) {
    console.error(`Couldn't check everything: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

if (!selfTest) {
  const { found, byEye, counts } = scanOrStop(folder);
  console.log(`Scanned ${counts.files} file(s) in ${folderArg}, including ${counts.members} member(s) inside zip files.`);
  if (found.length === 0) console.log("Found: nothing (no API key, no token, cookie or credential, no home-folder address).");
  else {
    console.log(`Found ${found.length} thing(s) (file:line and kind; the values are never shown):`);
    for (const f of found) console.log(`  ${shown(f)}`);
  }
  console.log("Not text, so check these by eye for personal data:");
  for (const place of byEye) console.log(`  ${place}`);
  console.log(found.length === 0 ? "PASS" : "FAIL");
  process.exit(found.length === 0 ? 0 : 1);
}

// SELF-TEST.
const copy = mkdtempSync(join(tmpdir(), "failure-evidence-self-test-"));
let passed = false;
try {
  cpSync(folder, copy, { recursive: true });
  const fake = () => randomBytes(16).toString("hex");
  const planted: { place: string; line: number; kind: string; value: string }[] = [];

  // Adds one line to the end of a text file in the copy and notes its line number.
  const appendLine = (text: string, line: string) => {
    const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
    return { text: `${body}${line}\n`, line: body.split("\n").length };
  };

  const token = `fake${fake()}`;
  const consolePath = join(copy, "console.txt");
  const consoleAdded = appendLine(readFileSync(consolePath, "utf8"), `+9.99s [log] Authorization: Bearer ${token}`);
  writeFileSync(consolePath, consoleAdded.text);
  planted.push({ place: "console.txt", line: consoleAdded.line, kind: "a bearer token", value: token });

  const cookie = `fake${fake()}`;
  const zipPath = join(copy, "trace.zip");
  const members = readZip(readFileSync(zipPath));
  const network = members.find((m) => /^\d+-trace\.network$/.test(m.name));
  if (!network) throw new Error("trace.zip has no network log to plant a cookie in");
  const networkAdded = appendLine(network.data.toString("utf8"), JSON.stringify({ type: "self-test", headers: [{ name: "Cookie", value: `session=${cookie}` }] }));
  network.data = Buffer.from(networkAdded.text, "utf8");
  writeFileSync(zipPath, writeZip(members));
  planted.push({ place: `trace.zip › ${network.name}`, line: networkAdded.line, kind: "a credential header with a value", value: cookie });

  const errorPath = join(copy, "error.txt");
  const errorAdded = appendLine(readFileSync(errorPath, "utf8"), `self-test: ${apiKey}`);
  writeFileSync(errorPath, errorAdded.text);
  planted.push({ place: "error.txt", line: errorAdded.line, kind: "the run's API key", value: apiKey });

  const { found } = scanOrStop(copy);
  console.log(`Self-test on a temporary copy of ${folderArg}: planted ${planted.length} fake value(s).`);
  let allFound = true;
  for (const p of planted) {
    const hit = found.some((f) => f.place === p.place && f.line === p.line && f.kind === p.kind);
    allFound &&= hit;
    console.log(`  ${hit ? "found    " : "MISSED   "} ${p.place}:${p.line}  ${p.kind}`);
  }
  const extra = found.filter((f) => !planted.some((p) => p.place === f.place && p.line === f.line));
  for (const f of extra) console.log(`  ALSO FOUND ${shown(f)}`);
  // The report must never show a value: none of the planted ones appears in what was printed.
  const printed = found.map(shown).join("\n");
  const leaked = planted.some((p) => printed.includes(p.value));
  if (leaked) console.log("  The report showed a planted value.");
  passed = allFound && extra.length === 0 && !leaked;
  console.log(passed ? "PASS: every planted value was found at its file and line, and no value was shown." : "FAIL");
} finally {
  rmSync(copy, { recursive: true, force: true });
}
process.exit(passed ? 0 : 1);
