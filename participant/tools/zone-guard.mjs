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
// --root is the repository to guard (default: the current folder). A relative <path> is taken
// from that folder. The rules are read from <root>/participant/context/zone-rules.md.
//
// How a write is checked (the "How the guard decides" list in zone-rules.md):
//   1. Resolve the path first: follow every ".." and every link to where the write would really
//      land. Comparing the text it was given is how ".." and links get through.
//   2. The real path must be inside the repository.
//   3. Its zone must exist in the table and allow agent writes. A missing or broken table refuses
//      everything.
//   4. Only a brand-new file is created, in a folder that already exists, never following a link
//      at the last step (O_CREAT | O_EXCL | O_NOFOLLOW), so a refused write leaves nothing behind.
//   5. Every refusal names the rule that refused it.
//
// Exit codes: 0 written (or zone reported), 1 refused, 2 usage error.
// Output never shows the computer's folders: paths are shown relative to the repository.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const RULES_FILE = "participant/context/zone-rules.md";
const COLUMNS = ["Zone", "Covers", "Who may write", "Git", "Agent may write"];
const q = (s) => JSON.stringify(s);

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
if (!target) usage();

let root;
try {
  root = realpathSync.native(rootArg);
  if (!lstatSync(root).isDirectory()) throw new Error();
} catch {
  console.error("The --root folder doesn't exist.");
  process.exit(2);
}

// ---- the rulebook ----------------------------------------------------------------------------
// Returns { zones: [{ name, agentMayWrite, entries }] } or { broken: "<why>" }.
const readRules = () => {
  const path = join(root, RULES_FILE);
  let source;
  try {
    // The rulebook itself must be an ordinary file in the repository, not a link to elsewhere.
    if (!lstatSync(path).isFile()) return { broken: "it is not an ordinary file" };
    source = readFileSync(path, "utf8");
  } catch {
    return { broken: "the file is missing" };
  }
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## Zones");
  if (start === -1) return { broken: 'it has no "## Zones" section' };
  const rows = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    const line = lines[i].trim();
    if (line.startsWith("|")) rows.push(line);
    else if (rows.length && line !== "") break; // the table has ended
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
  const seen = new Map(); // entry -> zone name
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
      if (seen.has(e)) return { broken: `entry ${q(e)} is listed under both ${q(seen.get(e))} and ${q(name)}` };
      seen.set(e, name);
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
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("*"))) return "is not a plain path";
  return null;
};

// Which zone holds `rel` (a path relative to the root, "/"-separated)? `isDir` says whether the
// path itself is a folder. Most specific wins: a **/ entry, then the longest path, then `*`.
const zoneOf = (zones, rel, isDir) => {
  const segs = rel.split("/");
  const folders = isDir ? segs : segs.slice(0, -1);
  const last = segs[segs.length - 1];
  let anywhere = null;
  let best = null;
  let top = null;
  for (const z of zones) {
    for (const e of z.entries) {
      let hit = false;
      if (e === "*") {
        if (segs.length === 1 && !isDir) top = { zone: z, entry: e };
        continue;
      }
      if (e.startsWith("**/")) {
        const name = e.slice(3);
        hit = name.endsWith("/") ? folders.includes(name.slice(0, -1)) : !isDir && last === name;
        if (hit) {
          if (anywhere && anywhere.zone !== z) return { ambiguous: [anywhere.entry, e] };
          anywhere = anywhere ?? { zone: z, entry: e };
        }
        continue;
      }
      hit = e.endsWith("/") ? `${rel}/`.startsWith(e) : rel === e && !isDir;
      if (hit && (!best || e.length > best.entry.length)) best = { zone: z, entry: e };
    }
  }
  return anywhere ?? best ?? top ?? null;
};

// ---- resolving the path ----------------------------------------------------------------------
// Follows ".." and every link in the folders leading to the target. The last part is not
// followed: for a write, a link standing there is refused when the file is created.
const shown = (real) => (real === root ? "." : relative(root, real).split(sep).join("/"));
const inside = (real) => real === root || real.startsWith(`${root}${sep}`);

// For `zone` only (`missingOk`), folders that don't exist yet are allowed: the nearest folder that
// does exist is resolved, and the rest of the path is added to it as written.
const resolveTarget = (given, missingOk = false) => {
  const lexical = resolve(root, given); // the text alone: ".." handled, links not followed
  const name = basename(lexical);
  if (lexical === root || name === "") return { error: "is the repository itself, not a file in it" };
  // A path ending in "/" (or "/." or "/..") names a folder; the guard only ever writes files.
  const endsAsFolder = /[\\/]$/.test(given) || /(^|[\\/])\.\.?$/.test(given);
  if (!missingOk && endsAsFolder) {
    return { error: "names a folder, not a file", rule: "rule 4: only a new file, in a folder that already exists" };
  }
  let dir = dirname(lexical);
  const rest = [name];
  for (;;) {
    try {
      const parent = realpathSync.native(dir);
      return { real: join(parent, ...rest), parent, lexical, missing: rest.length > 1 };
    } catch (err) {
      if (!missingOk || err.code !== "ENOENT" || dirname(dir) === dir) {
        return { error: "is in a folder that doesn't exist", rule: "rule 4: only a new file, in a folder that already exists" };
      }
      rest.unshift(basename(dir));
      dir = dirname(dir);
    }
  }
};

const refuse = (rule, detail, extra = []) => {
  console.log(`REFUSED: ${q(target)}`);
  for (const line of extra) console.log(`  ${line}`);
  console.log(`  rule: ${rule}`);
  console.log(`  why: ${detail}`);
  console.log("  nothing was written.");
  process.exitCode = 1;
};

// ---- zone ------------------------------------------------------------------------------------
const rules = readRules();
const r = resolveTarget(target, command === "zone");

if (command === "zone") {
  if (rules.broken) {
    console.log(`Rules table missing or broken: ${rules.broken}. Every write would be refused.`);
    process.exitCode = 1;
  } else if (r.error) {
    console.log(`${q(target)} ${r.error}.`);
    process.exitCode = 1;
  } else if (!inside(r.real)) {
    console.log(`${q(target)} leads outside the repository: in no zone, and never writable.`);
    process.exitCode = 1;
  } else {
    let isDir = false;
    let exists = false;
    try {
      const st = lstatSync(r.real);
      exists = true;
      isDir = st.isDirectory();
    } catch { /* doesn't exist yet: treated as a file */ }
    const rel = shown(r.real);
    const z = zoneOf(rules.zones, rel, isDir);
    // When ".." or a link changed where the path really lands, say so first.
    if (shown(r.lexical) !== rel || target.split(/[\\/]/).includes("..")) console.log(`${q(target)} really lands at ${q(rel)}.`);
    if (!z) console.log(`${q(rel)} is in no zone: an agent may not write there until it is added to the rules.`);
    else if (z.ambiguous) console.log(`${q(rel)} matches entries of two zones (${z.ambiguous.join(", ")}): the rules are ambiguous, so writing is refused.`);
    else console.log(`${q(rel)} is in the ${z.zone.name} zone (entry \`${z.entry}\`). Agent may write: ${z.zone.agentMayWrite ? "yes" : "no"}.`);
    if (z && !z.ambiguous && z.zone.agentMayWrite && exists) {
      console.log("  (Something already stands at that path, so `write` would refuse it: the guard only creates new files.)");
    }
    if (!z || z.ambiguous) process.exitCode = 1;
  }
  process.exit();
}

// ---- write -----------------------------------------------------------------------------------
if (rules.broken) {
  refuse("rule 3: a missing or broken rules table refuses every write", `${RULES_FILE}: ${rules.broken}`);
} else if (r.error) {
  refuse(r.rule ?? "the target must be a file", `the path ${r.error}`);
} else if (!inside(r.real)) {
  // Say which escape it was: the text itself (".." or an absolute path), or a link on the way.
  const how = inside(r.lexical) ? "a link on the way leads outside the repository" : isAbsolute(target) ? "it is an absolute path outside the repository" : '".." climbs out of the repository';
  refuse("rule 2: the real path must be inside the repository", how, ["real path: outside the repository"]);
} else {
  const rel = shown(r.real);
  const viaLink = shown(r.lexical) !== rel;
  const viaDots = target.split(/[\\/]/).includes("..");
  const how = [viaDots && '".." resolved first', viaLink && "reached through a link"].filter(Boolean).join(", ");
  const extra = [`real path: ${q(rel)}${how ? ` (${how})` : ""}`];
  const z = zoneOf(rules.zones, rel, false);
  if (!z) {
    refuse("rule 3: a path in no zone is never written", "no entry in the Zones table covers it", extra);
  } else if (z.ambiguous) {
    refuse("rule 3: an ambiguous table refuses the write", `entries of two zones match: ${z.ambiguous.join(", ")}`, extra);
  } else if (!z.zone.agentMayWrite) {
    extra.push(`zone: ${z.zone.name} (entry \`${z.entry}\`)`);
    refuse(`rule 3: the ${z.zone.name} zone has "Agent may write: no"`, "an agent may not write in this zone", extra);
  } else {
    // Rule 4: brand-new file only, never through a link at the last step.
    let fd;
    try {
      fd = openSync(r.real, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    } catch (err) {
      const why = err.code === "EEXIST" ? "something (a file, folder or link) already stands at that path" : `the file couldn't be created (${err.code})`;
      refuse("rule 4: only a brand-new file, never overwriting or following a link", why, extra);
    }
    if (fd !== undefined) {
      let ok = false;
      let swapped = false;
      try {
        // Re-check after creating: the folder must still be where it was resolved to, and the
        // file just opened must be the one at that path (nothing was swapped in meanwhile).
        const same = realpathSync.native(dirname(r.lexical)) === r.parent && (() => {
          const a = fstatSync(fd);
          const b = lstatSync(r.real);
          return a.ino === b.ino && a.dev === b.dev;
        })();
        if (!same) {
          swapped = true;
          throw new Error("swapped");
        }
        const bytes = Buffer.from(text, "utf8");
        let done = 0;
        while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
        ok = true;
        console.log(`WRITTEN: ${q(rel)} (${bytes.length} bytes)`);
        console.log(`  zone: ${z.zone.name} (entry \`${z.entry}\`), Agent may write: yes`);
      } catch (err) {
        if (swapped) {
          // Don't delete: the folder changed under us, so the path may no longer mean this file.
          console.log(`STOPPED: ${q(target)}: a folder on the way changed while writing. Check ${q(rel)} by hand; the new file is empty.`);
        } else {
          console.log(`FAILED: ${q(target)}: writing failed (${err.code ?? "error"}); the new file was removed.`);
        }
        process.exitCode = 1;
      } finally {
        closeSync(fd);
        // Only an ordinary failure removes the half-written file; a swap leaves it for a person.
        if (!ok && !swapped) {
          try {
            unlinkSync(r.real);
          } catch { /* already gone */ }
        }
      }
    }
  }
}
