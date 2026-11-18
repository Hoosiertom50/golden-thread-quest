// Checks the ticket reader's own code (participant/tools/ticket-reader.mjs) for any ability to act,
// for the base-camp-prompt-injection quest. Node's permission mode already refuses writing files and
// starting programs when the reader runs; this covers what that mode doesn't: the network, and the
// code quietly growing an ability later.
//
// It passes only if the reader:
//   - imports exactly one thing: readFileSync from "node:fs";
//   - uses no require(), no dynamic import(), no eval or new Function (ways to load more code);
//   - names nothing that sends, writes or runs: fetch, XMLHttpRequest, WebSocket, http, https, net,
//     tls, dgram, dns, child_process, worker_threads, cluster, process.binding, writeFile,
//     appendFile, createWriteStream, open (for writing), mkdir, rm, rename, unlink, copyFile,
//     symlink, chmod, chown, truncate, utimes, exec, spawn, fork.
// The whole file is checked as written, comments included (a call written even in a comment fails).
//
// Run it from the repository's top folder:
//   node participant/tools/check-reader-code.mjs [file]
// PASS (exit 0), FAIL (exit 1, each finding by line), or exit 2 if the file can't be read.

import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "participant/tools/ticket-reader.mjs";
let source;
try {
  source = readFileSync(file, "utf8");
} catch (error) {
  console.error(`Couldn't read ${file} (${error.code ?? "an unexpected error"}).`);
  process.exit(2);
}

// The whole file is checked as written, comments included: guessing what is a comment can be fooled
// (a "//" inside a string would hide the rest of its line), so nothing is set aside. A use in a
// comment counts too, which can only make the check stricter. What counts is a USE: calling a name,
// reaching it as a property, or naming a module that can act; a plain word inside text the reader
// searches for (such as its phrase "rm rf") is not a use.
const code = source;
const lineOf = (index) => code.slice(0, index).split("\n").length;
const findings = [];

const imports = [...code.matchAll(/^[ \t]*import\b[^;\n]*?from[ \t]*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']/gm)];
const allowed = /^[ \t]*import[ \t]*\{[ \t]*readFileSync[ \t]*\}[ \t]*from[ \t]*["']node:fs["'][ \t]*;?[ \t]*$/;
for (const m of imports) {
  const statement = code.slice(m.index, code.indexOf("\n", m.index) === -1 ? undefined : code.indexOf("\n", m.index));
  if (!allowed.test(statement)) findings.push(`line ${lineOf(m.index)}: imports something other than readFileSync from node:fs`);
}
if (imports.length !== 1) findings.push(`${imports.length} import statements; exactly 1 (readFileSync from node:fs) is allowed`);

// Names that load more code, reach the network, write, or run something: found when called
// (name followed by "("), reached as a property (".name"), or created ("new name").
const ACTING = [
  "require", "import", "eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "binding", "dlopen", "writeFile\\w*", "appendFile\\w*", "createWriteStream", "open\\w*",
  "mkdir\\w*", "rm\\w*", "rename\\w*", "unlink\\w*", "copyFile\\w*", "cp\\w*", "symlink\\w*",
  "link\\w*", "chmod\\w*", "chown\\w*", "truncate\\w*", "utimes\\w*", "exec\\w*", "spawn\\w*", "fork",
  "request", "connect", "createConnection", "createServer", "send\\w*",
];
for (const name of ACTING) {
  const use = new RegExp(`(?<![\\w$])(?:${name})[ \\t]*\\(|\\.(?:${name})(?![\\w$])|\\bnew[ \\t]+(?:${name})(?![\\w$])`, "g");
  for (const m of code.matchAll(use)) findings.push(`line ${lineOf(m.index)}: uses "${m[0].trim()}"`);
}
// Modules that can act, named anywhere (an import, a require, a string handed to a loader).
const MODULES = ["http", "https", "http2", "net", "tls", "dgram", "dns", "child_process", "worker_threads", "cluster", "inspector", "vm", "fs/promises"];
for (const m of code.matchAll(new RegExp(`["'](?:node:)?(?:${MODULES.join("|")})["']`, "g"))) {
  findings.push(`line ${lineOf(m.index)}: names the module ${m[0]}`);
}

console.log(`Checked ${file}: ${source.split("\n").length} lines, ${imports.length} import statement(s).`);
if (findings.length === 0) {
  console.log("PASS: it imports only readFileSync from node:fs, and uses nothing that could send, write or run.");
  process.exit(0);
}
for (const f of findings) console.log(`  ${f}`);
console.log(`FAIL: ${findings.length} finding(s).`);
process.exit(1);
