// The write-guard for the base-camp-ownership-zones quest: every file an agent writes goes through
// it, and it checks the write against the zone rules before anything is created. Its rulebook is
// the Zones table in participant/context/zone-rules.md (read fresh on every run), so the rules
// people read and the rules the tool enforces are one and the same.
//
//   node participant/tools/zone-guard.mjs write <path> <text> [--root <folder>]
//       Creates <path> holding <text>, if the rules allow it. Otherwise refuses, names the rule
//       that refused it, and creates nothing.
//   node participant/tools/zone-guard.mjs zone <path> [--root <folder>]
//       Says which zone <path> is in and whether an agent may write there. Writes nothing.
//
// --root is the repository to guard (default: the current folder); it is recognised only as the
// last two arguments. A relative <path> is taken from that folder. The rules are read from
// <root>/participant/context/zone-rules.md, which must really be inside <root>.
//
// How a write is checked (the "How the guard decides" list in zone-rules.md):
//   1. Resolve the path first: the operating system follows every ".." and every link in the
//      folders, in order, to where the write would really land. Comparing the text it was given is
//      how ".." and links get through.
//   2. The real path must be inside the repository.
//   3. Its zone must exist in the table and allow agent writes. A missing or broken table refuses
//      everything. Names are compared without regard to capital letters (macOS treats `.DS_Store`
//      and `.ds_store` as the same file).
//   4. Only a brand-new file is created, in a folder that already exists, never following a link
//      at the last step. The guard first moves into the checked folder and creates the file from
//      there, so the folder can't be swapped for a link between the check and the write; it then
//      checks the folder is still where it was and removes its own file if not.
//   5. Every refusal names the rule that refused it.
//
// Exit codes: 0 written (or zone reported), 1 refused, 2 usage error.
// Output never shows the computer's folders: paths are shown relative to the repository.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const RULES_FILE = "participant/context/zone-rules.md";
const COLUMNS = ["Zone", "Covers", "Who may write", "Git", "Agent may write"];
const q = (s) => JSON.stringify(s);
const fold = (s) => s.normalize("NFC").toLowerCase(); // names compared without regard to capitals

// ---- arguments -------------------------------------------------------------------------------
const usage = () => {
  console.error("Usage:\n  node participant/tools/zone-guard.mjs write <path> <text> [--root <folder>]\n  node participant/tools/zone-guard.mjs zone <path> [--root <folder>]");
  process.exit(2);
};
const args = process.argv.slice(2);
let rootArg = ".";
// --root is recognised only as the last two arguments, so a note's text can be anything.
if (args.length >= 2 && args[args.length - 2] === "--root") {
  rootArg = args[args.length - 1];
  args.splice(args.length - 2, 2);
}
const [command, target, text] = args;
if (command === "write" ? args.length !== 3 : command === "zone" ? args.length !== 2 : true) usage();
if (!target || target.includes("\0")) usage();

let root;
try {
  root = realpathSync.native(rootArg);
  if (!lstatSync(root).isDirectory()) throw new Error();
} catch {
  console.error("The --root folder doesn't exist.");
  process.exit(2);
}
const inside = (real) => real === root || real.startsWith(`${root}${sep}`);
const shown = (real) => (real === root ? "." : relative(root, real).split(sep).join("/"));

// ---- the rulebook ----------------------------------------------------------------------------
// Returns { zones: [{ name, agentMayWrite, entries }] } or { broken: "<why>" }.
const readRules = () => {
  const path = `${root}/${RULES_FILE}`;
  let source;
  try {
    // The rulebook must be an ordinary file (not a link) whose real location is in the repository:
    // a linked folder on the way can't bring in rules from elsewhere.
    if (!lstatSync(path).isFile()) return { broken: "it is not an ordinary file" };
    if (realpathSync.native(path) !== `${root}${sep}${RULES_FILE.split("/").join(sep)}`) {
      return { broken: "it is reached through a link; it must really be at that path in the repository" };
    }
    source = readFileSync(path, "utf8");
  } catch {
    return { broken: "the file is missing" };
  }
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## Zones");
  if (start === -1) return { broken: 'it has no "## Zones" section' };
  // The table is the first run of lines starting with "|" in the section. It must end with a blank
  // line or the end of the section: a line straight after a row that isn't a row (a row that lost
  // its leading "|", say) breaks the table rather than quietly ending it.
  const rows = [];
  let i = start + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  for (; i < lines.length && !lines[i].startsWith("## "); i++) {
    const line = lines[i].trim();
    if (line === "") break;
    if (!line.startsWith("|")) return { broken: `a line inside the Zones table isn't a table row: ${q(line)}` };
    rows.push(line);
  }
  const cells = (row) => {
    if (!row.endsWith("|") || row.length < 2) return null;
    return row.slice(1, -1).split("|").map((c) => c.trim());
  };
  if (rows.length < 3) return { broken: "the Zones table has no rows" };
  const header = cells(rows[0]);
  if (!header || header.join("|") !== COLUMNS.join("|")) {
    return { broken: `the Zones table's columns must be: ${COLUMNS.join(", ")}` };
  }
  const divider = cells(rows[1]);
  if (!divider || divider.length !== COLUMNS.length || !divider.every((c) => /^:?-+:?$/.test(c))) {
    return { broken: "the Zones table's second line must be its divider" };
  }
  const zones = [];
  const seen = new Map(); // folded entry -> zone name
  for (const row of rows.slice(2)) {
    const c = cells(row);
    if (!c || c.length !== COLUMNS.length) return { broken: `a row doesn't have ${COLUMNS.length} columns: ${q(row)}` };
    const [name, covers, , git, write] = c;
    if (!name) return { broken: "a row has no zone name" };
    if (zones.some((z) => z.name === name)) return { broken: `zone ${q(name)} is listed twice` };
    if (write !== "yes" && write !== "no") return { broken: `zone ${q(name)}: "Agent may write" must be yes or no` };
    if (git !== "tracked" && git !== "ignored") return { broken: `zone ${q(name)}: "Git" must be tracked or ignored` };
    // Covers is a list of `entries` in backticks, separated by spaces, and nothing else.
    if (!/^(`[^`\s]+`)( `[^`\s]+`)*$/.test(covers)) return { broken: `zone ${q(name)}: "Covers" must be entries in backticks, separated by spaces` };
    const entries = covers.slice(1, -1).split("` `");
    for (const e of entries) {
      const bad = checkEntry(e);
      if (bad) return { broken: `zone ${q(name)}: entry ${q(e)} ${bad}` };
      if (seen.has(fold(e))) return { broken: `entry ${q(e)} is listed twice (under ${q(seen.get(fold(e)))} and ${q(name)})` };
      seen.set(fold(e), name);
    }
    zones.push({ name, agentMayWrite: write === "yes", entries });
  }
  return { zones };
};

// Entry forms: `*`, `**/name/` or `**/name`, `a/b/` (a folder), `a/b` (a file).
const checkEntry = (e) => {
  if (e === "*") return null;
  const body = e.startsWith("**/") ? e.slice(3) : e;
  const parts = (body.endsWith("/") ? body.slice(0, -1) : body).split("/");
  if (e.startsWith("**/") && parts.length !== 1) return "must name a single folder or file after **/";
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("*") || p.includes("\\"))) return "is not a plain path";
  return null;
};

// Which zone holds `rel` (a real path relative to the root, "/"-separated)? `isDir` says whether
// the path itself is a folder. Most specific wins: a **/ entry, then the longest path, then `*`.
// A folder entry covers the things inside the folder (and, when asking about a folder, the folder
// itself), never a file that happens to have the folder's name.
const zoneOf = (zones, rel, isDir) => {
  const f = fold(rel);
  const segs = f.split("/");
  const folders = isDir ? segs : segs.slice(0, -1);
  const last = segs[segs.length - 1];
  let anywhere = null;
  let best = null;
  let top = null;
  for (const z of zones) {
    for (const entry of z.entries) {
      const e = fold(entry);
      if (e === "*") {
        if (segs.length === 1 && !isDir) top = { zone: z, entry };
        continue;
      }
      if (e.startsWith("**/")) {
        const name = e.slice(3);
        const hit = name.endsWith("/") ? folders.includes(name.slice(0, -1)) : !isDir && last === name;
        if (hit) {
          if (anywhere && anywhere.zone !== z) return { ambiguous: [anywhere.entry, entry] };
          anywhere = anywhere ?? { zone: z, entry };
        }
        continue;
      }
      const hit = e.endsWith("/") ? f.startsWith(e) || (isDir && `${f}/` === e) : f === e && !isDir;
      if (hit && (!best || e.length > best.entry.length)) best = { zone: z, entry };
    }
  }
  return anywhere ?? best ?? top ?? null;
};

// ---- resolving the path ----------------------------------------------------------------------
// The folders are resolved by the operating system exactly as written, so ".." after a link
// means what it means to the system (the link's destination's parent), not a tidied-up text.
// The last part is not followed: for a write, a link standing there is refused when the file is
// created. For `zone` only (`missingOk`), folders that don't exist yet are allowed: the nearest
// one that does is resolved and the rest is added as written.
const resolveTarget = (given, missingOk) => {
  if (given.endsWith("/") && !missingOk) return { error: "names a folder, not a file", rule: "rule 4: only a new file, in a folder that already exists" };
  const trimmed = given.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  let dirParts = cut === -1 ? [] : trimmed.slice(0, cut).split("/");
  const absolute = isAbsolute(given);
  if (name === "" || name === "." || name === "..") {
    return missingOk ? { folderOnly: true } : { error: "names a folder, not a file", rule: "rule 4: only a new file, in a folder that already exists" };
  }
  const rest = [name];
  for (;;) {
    const dir = absolute ? dirParts.join("/") || "/" : [root, ...dirParts].join("/");
    try {
      const parent = realpathSync.native(dir);
      return { real: parent === "/" ? `/${rest.join("/")}` : [parent, ...rest].join("/"), parent, name };
    } catch (err) {
      const popped = dirParts[dirParts.length - 1];
      if (!missingOk || err.code !== "ENOENT" || dirParts.length === 0 || popped === "." || popped === ".." || popped === "") {
        return { error: "is in a folder that doesn't exist", rule: "rule 4: only a new file, in a folder that already exists" };
      }
      rest.unshift(popped);
      dirParts = dirParts.slice(0, -1);
    }
  }
};

// What the text alone says (for messages only, never for the decision): "..", or a link.
const describe = (given, rel) => {
  const tidy = tidyText(given);
  const how = [];
  if (given.split("/").includes("..")) how.push('".." resolved first');
  if (tidy !== null && fold(tidy) !== fold(rel)) how.push("reached through a link");
  return how.length ? ` (${how.join(", ")})` : "";
};
const tidyText = (given) => {
  const parts = [];
  for (const p of given.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  return isAbsolute(given) ? null : parts.join("/");
};

const refuse = (rule, detail, extra = []) => {
  console.log(`REFUSED: ${q(target)}`);
  for (const line of extra) console.log(`  ${line}`);
  console.log(`  rule: ${rule}`);
  console.log(`  why: ${detail}`);
  console.log("  nothing was written.");
  process.exitCode = 1;
};

const rules = readRules();

// ---- zone ------------------------------------------------------------------------------------
if (command === "zone") {
  const r = resolveTarget(target, true);
  if (rules.broken) {
    console.log(`Rules table missing or broken: ${rules.broken}. Every write would be refused.`);
    process.exitCode = 1;
  } else if (r.folderOnly) {
    console.log(`${q(target)} ends in "." or "..": ask about the folder by its name instead.`);
    process.exitCode = 1;
  } else if (r.error) {
    console.log(`${q(target)} ${r.error}.`);
    process.exitCode = 1;
  } else {
    // A link standing at the last step is followed here, so a linked folder is reported where it
    // really leads. (A write there is refused anyway: the guard never writes through a link.)
    let real = r.real;
    let exists = false;
    let isDir = false;
    let link = false;
    try {
      const st = lstatSync(real);
      exists = true;
      link = st.isSymbolicLink();
      if (link) real = realpathSync.native(real);
      isDir = lstatSync(real).isDirectory();
    } catch { /* doesn't exist yet (or a link to nothing): treated as a file */ }
    if (!inside(real)) {
      console.log(`${q(target)} leads outside the repository: in no zone, and never writable.`);
      process.exitCode = 1;
    } else {
      const rel = shown(real);
      const z = zoneOf(rules.zones, rel, isDir);
      if (fold(rel) !== fold(target.replace(/\/+$/, "")) && describe(target, rel)) console.log(`${q(target)} really lands at ${q(rel)}.`);
      if (!z) console.log(`${q(rel)} is in no zone: an agent may not write there until it is added to the rules.`);
      else if (z.ambiguous) console.log(`${q(rel)} matches entries of two zones (${z.ambiguous.join(", ")}): the rules are ambiguous, so writing is refused.`);
      else console.log(`${q(rel)} is in the ${z.zone.name} zone (entry \`${z.entry}\`). Agent may write: ${z.zone.agentMayWrite ? "yes" : "no"}.`);
      if (z && !z.ambiguous && z.zone.agentMayWrite && exists) {
        console.log(`  (${link ? "A link" : "Something"} already stands at that path, so \`write\` would refuse it: the guard only creates new files.)`);
      }
      if (!z || z.ambiguous) process.exitCode = 1;
    }
  }
  process.exit();
}

// ---- write -----------------------------------------------------------------------------------
const r = resolveTarget(target, false);
if (rules.broken) {
  refuse("rule 3: a missing or broken rules table refuses every write", `${RULES_FILE}: ${rules.broken}`);
} else if (r.error) {
  refuse(r.rule, `the path ${r.error}`);
} else if (!inside(r.real) || r.real === root) {
  const tidy = tidyText(target);
  const how = isAbsolute(target) ? "it is an absolute path outside the repository" : tidy === null ? '".." climbs out of the repository' : "a link on the way leads outside the repository";
  refuse("rule 2: the real path must be inside the repository", how, ["real path: outside the repository"]);
} else {
  const rel = shown(r.real);
  const extra = [`real path: ${q(rel)}${describe(target, rel)}`];
  const z = zoneOf(rules.zones, rel, false);
  if (!z) {
    refuse("rule 3: a path in no zone is never written", "no entry in the Zones table covers it", extra);
  } else if (z.ambiguous) {
    refuse("rule 3: an ambiguous table refuses the write", `entries of two zones match: ${z.ambiguous.join(", ")}`, extra);
  } else if (!z.zone.agentMayWrite) {
    extra.push(`zone: ${z.zone.name} (entry \`${z.entry}\`)`);
    refuse(`rule 3: the ${z.zone.name} zone has "Agent may write: no"`, "an agent may not write in this zone", extra);
  } else {
    writeNew(r, rel, z, extra);
  }
}

// Rule 4. Moving into the checked folder pins it: from then on the file is created in that very
// folder, by its bare name, whatever happens to the path that led to it. Before and after, the
// folder must still be found at the checked path; otherwise the guard's own new file is removed.
function writeNew(r, rel, z, extra) {
  try {
    process.chdir(r.parent);
  } catch (err) {
    refuse("rule 4: only a new file, in a folder that already exists", `the folder couldn't be entered (${err.code})`, extra);
    return;
  }
  const here = () => {
    try {
      return realpathSync.native(".");
    } catch {
      return null;
    }
  };
  if (here() !== r.parent) {
    refuse("rule 4: only a new file, in a folder that already exists", "the folder changed while it was being checked", extra);
    return;
  }
  let fd;
  try {
    fd = openSync(r.name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (err) {
    const why = err.code === "EEXIST" ? "something (a file, folder or link) already stands at that path" : `the file couldn't be created (${err.code})`;
    refuse("rule 4: only a brand-new file, never overwriting or following a link", why, extra);
    return;
  }
  let ok = false;
  let problem = "";
  let mine = null; // the identity of the file this run created
  const isMine = () => {
    try {
      const b = lstatSync(r.name);
      return mine !== null && b.ino === mine.ino && b.dev === mine.dev;
    } catch {
      return false;
    }
  };
  try {
    mine = fstatSync(fd);
    const bytes = Buffer.from(text, "utf8");
    let done = 0;
    while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
    // The folder must still be where it was checked, and the file at that name must be this one.
    if (here() !== r.parent) problem = "the folder was moved while writing";
    else if (!isMine()) problem = "the new file was replaced while writing";
    else {
      ok = true;
      console.log(`WRITTEN: ${q(rel)} (${bytes.length} bytes)`);
      console.log(`  zone: ${z.zone.name} (entry \`${z.entry}\`), Agent may write: yes`);
    }
  } catch (err) {
    problem = `writing failed (${err.code ?? "error"})`;
  } finally {
    closeSync(fd);
  }
  if (!ok) {
    // Removed by its bare name in the pinned folder, and only if it is still the file this run
    // created: nothing else can be deleted.
    let removed = false;
    if (isMine()) {
      try {
        unlinkSync(r.name);
        removed = true;
      } catch { /* left for a person */ }
    }
    console.log(`FAILED: ${q(target)}: ${problem}; ${removed ? "the new file was removed" : `the new file couldn't be removed, check ${q(rel)} by hand`}.`);
    process.exitCode = 1;
  }
}
