// Checks the decision log for the context-decision-log quest, one acceptance criterion at a time,
// and builds its "Current decisions" view. It reads three files in one folder (default
// participant/context/decisions): log.md (the entries), rules.md (who may approve what) and
// sources.md (the written records the entries cite, and the work items).
//
//   node participant/tools/decision-check.mjs [--dir <folder>] [--previous <earlier log.md>]
//                                             [--write-view | --print-view]
//
//   --previous   also checks that the log was only added to since that earlier copy: its entries
//                are still the first ones, in the same order, each with the same lines in the same
//                order, and the only lines added to them are "Became" and "Replaced by".
//   --write-view rewrites the Current decisions list (only the lines between its two markers)
//                from the entries, but only if every other check passes; otherwise nothing is
//                written. The file keeps its line endings and permissions.
//   --print-view prints the list the entries call for, without checking or writing anything.
//
// The list shows each decision's approved words, taken from the approver's own line, not the
// entry's title, so what is shown as decided is exactly what was approved.
//
// Text inside HTML comments (<!-- -->) and fenced code blocks is ignored: it isn't part of the
// record a reader sees.
//
// Exit codes: 0 every check passed, 1 at least one problem, 2 a file couldn't be read or the
// arguments were wrong.

import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

const usage = () => {
  console.error("Usage: node participant/tools/decision-check.mjs [--dir <folder>] [--previous <earlier log.md>] [--write-view | --print-view]");
  process.exit(2);
};
let dir = "participant/context/decisions";
let previous = null;
let mode = "check";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && i + 1 < args.length) dir = args[++i];
  else if (args[i] === "--previous" && i + 1 < args.length) previous = args[++i];
  else if ((args[i] === "--write-view" || args[i] === "--print-view") && mode === "check") mode = args[i].slice(2);
  else usage();
}
// Folders are shown as given, except an absolute one (it could show this computer's folders).
const shownDir = isAbsolute(dir) ? `(folder ${basename(dir)})` : dir;
const readRaw = (path, what) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`Couldn't read ${what}.`);
    process.exit(2);
  }
};
const lf = (raw) => raw.replace(/\r\n/g, "\n");
// The visible text: comments and fenced code blocks blanked out, keeping every line in place.
const visible = (text) => text
  .replace(/<!--[\s\S]*?(-->|$)/g, (m) => m.replace(/[^\n]/g, ""))
  .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, (m) => m.replace(/[^\n]/g, ""));

const logPath = join(dir, "log.md");
const logRaw = readRaw(logPath, `${shownDir}/log.md`);
const logText = lf(logRaw);
const rulesText = visible(lf(readRaw(join(dir, "rules.md"), `${shownDir}/rules.md`)));
const sourcesText = visible(lf(readRaw(join(dir, "sources.md"), `${shownDir}/sources.md`)));

// ---- reading the files ----------------------------------------------------------------------
// The lines under the one heading `<#…> <exact>`, up to the next heading of that level or higher.
// Returns { lines, start } or { problem }.
const section = (text, level, exact, file) => {
  const lines = text.split("\n");
  const head = `${"#".repeat(level)} ${exact}`;
  const at = lines.flatMap((l, i) => (l.trimEnd() === head ? [i] : []));
  if (at.length !== 1) return { problem: `${file} must have exactly one "${head}" heading (found ${at.length})` };
  const out = [];
  for (let i = at[0] + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return { lines: out, start: at[0] };
};
// A table row's cells: the leading "|" required, the trailing one optional, "\|" an escaped bar.
const cellsOf = (line) => {
  let t = line.trim();
  if (!t.startsWith("|")) return null;
  t = t.slice(1);
  if (/(^|[^\\])\|$/.test(t)) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};
const tableRows = (lines) => (lines ?? []).filter((l) => l.trim().startsWith("|")).slice(2).map(cellsOf);
const ticks = (c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const setupProblems = [];
// rules.md: who may approve which areas.
const approvers = new Map();
const who = section(rulesText, 2, "Who may approve", "rules.md");
if (who.problem) setupProblems.push(who.problem);
for (const row of tableRows(who.lines)) {
  if (!row[0] || row.length < 3) setupProblems.push('rules.md: a "Who may approve" row is incomplete');
  else if (approvers.has(row[0])) setupProblems.push(`rules.md lists ${row[0]} twice`);
  else approvers.set(row[0], ticks(row[2]));
}
if (!approvers.size) setupProblems.push('rules.md has no approvers in its "Who may approve" table');

// sources.md: each "## ID · title" section (its visible lines), and the work-items table.
const sources = new Map();
const srcLines = sourcesText.split("\n");
for (let i = 0; i < srcLines.length; i++) {
  const m = /^## ([A-Z]+-\d+) · .+$/.exec(srcLines[i]);
  if (!m) continue;
  if (sources.has(m[1])) setupProblems.push(`sources.md has two sections for ${m[1]}`);
  const body = [];
  for (let j = i + 1; j < srcLines.length && !/^#{1,2} /.test(srcLines[j]); j++) body.push(srcLines[j].trim());
  sources.set(m[1], body);
}
if (!sources.size) setupProblems.push("sources.md has no sources");
const workItems = new Map();
const wi = section(sourcesText, 2, "Work items", "sources.md");
if (wi.problem) setupProblems.push(wi.problem);
for (const row of tableRows(wi.lines)) {
  const [id, , restsOn] = row ?? [];
  if (!/^[A-Z]+-\d+$/.test(id ?? "")) setupProblems.push(`sources.md: a work-items row has no valid ID: ${JSON.stringify(row)}`);
  else if (workItems.has(id)) setupProblems.push(`sources.md lists work item ${id} twice`);
  else {
    const rests = (restsOn ?? "").split(/\s+/).filter(Boolean);
    if (!rests.length) setupProblems.push(`work item ${id} names no decision it rests on`);
    workItems.set(id, rests);
  }
}

// log.md: the entries under "## Entries", each "### ID · title" with "- Field: value" lines.
const FIELDS = {
  decision: { required: ["Status", "Date", "Source", "Area", "Approver", "Approval", "Affects"], optional: ["From", "Replaces", "Replaced by", "Note"] },
  proposal: { required: ["Status", "Date", "Source", "Proposed by"], optional: ["Became", "Note"] },
  question: { required: ["Status", "Date", "Source", "Asked by"], optional: ["Became", "Note"] },
};
const PREFIX = { decision: "D", proposal: "P", question: "Q" };
const parseEntries = (text, problems, file) => {
  const entries = [];
  const sec = section(visible(text), 2, "Entries", file);
  if (sec.problem) {
    problems.push(sec.problem);
    return entries;
  }
  let cur = null;
  for (const line of sec.lines) {
    const h = /^### (\S+) · (.+)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), fields: new Map(), lines: [] };
      entries.push(cur);
      continue;
    }
    if (line.trim() === "") continue;
    if (!cur) {
      problems.push(`${file}: a line before the first entry: ${JSON.stringify(line)}`);
      continue;
    }
    const f = /^- ([A-Za-z ]+?):(?: (.*))?$/.exec(line);
    if (!f) {
      problems.push(`${cur.id}: a line that isn't "- Field: value": ${JSON.stringify(line)}`);
      continue;
    }
    const value = (f[2] ?? "").trim();
    if (cur.fields.has(f[1])) problems.push(`${cur.id}: "${f[1]}" is given twice`);
    if (value === "") problems.push(`${cur.id}: "${f[1]}" is empty`);
    cur.fields.set(f[1], value);
    cur.lines.push(`${f[1]}: ${value}`);
  }
  return entries;
};

// ---- the current-decisions view --------------------------------------------------------------
const START = "<!-- current-decisions: start -->";
const END = "<!-- current-decisions: end -->";
const status = (e) => e.fields.get("Status");
// The approved words: the approver's line after "Approved by <name>: ".
const approvedWords = (e) => {
  const quote = /^"(.*)"$/.exec(e.fields.get("Approval") ?? "")?.[1] ?? "";
  const prefix = `Approved by ${e.fields.get("Approver")}: `;
  return quote.startsWith(prefix) ? quote.slice(prefix.length) : quote;
};
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|");
const buildView = (list) => {
  const live = list.filter((e) => status(e) === "decision" && !e.fields.has("Replaced by"));
  const rows = live.map((e) => `| ${cell(e.id)} | ${cell(approvedWords(e))} | ${cell(e.fields.get("Area"))} | ${cell(e.fields.get("Approver"))} | ${cell(e.fields.get("Date"))} | ${cell(e.fields.get("Source"))} |`);
  return ["| Decision | What was approved (the approver's words) | Area | Approved by | Date | Where |", "|---|---|---|---|---|---|", ...rows].join("\n");
};
// The markers: exactly one pair, both inside the "## Current decisions" section, in order.
const viewOf = (text) => {
  const sec = section(text, 2, "Current decisions", "log.md");
  if (sec.problem) return { problem: sec.problem };
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (l.trim() === START ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === END ? [i] : []));
  const first = sec.start + 1;
  const last = sec.start + sec.lines.length;
  if (starts.length !== 1 || ends.length !== 1) return { problem: "log.md needs exactly one pair of current-decisions markers" };
  if (!(first <= starts[0] && starts[0] < ends[0] && ends[0] <= last)) return { problem: 'both current-decisions markers must be inside "## Current decisions", start before end' };
  return { start: starts[0], end: ends[0], inner: lines.slice(starts[0] + 1, ends[0]).join("\n").trim() };
};

const parseProblems = [];
const entries = parseEntries(logText, parseProblems, "log.md");
if (mode === "print-view") {
  console.log(buildView(entries));
  process.exit(0);
}

// ---- the checks -------------------------------------------------------------------------------
const byId = new Map();
const index = new Map(entries.map((e, i) => [e.id, i]));
const results = [];
const check = (title, fn) => {
  const problems = [];
  fn(problems);
  results.push({ title, problems });
};
const validDate = (d) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d ?? "");
  if (!m) return null;
  const t = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  return t.getUTCMonth() === +m[1] - 1 && t.getUTCDate() === +m[2] ? t.getTime() : null;
};
// True only when both dates are real and `a` is earlier than `b` (a bad date is reported by check 6).
const earlier = (a, b) => {
  const x = validDate(a);
  const y = validDate(b);
  return x !== null && y !== null && x < y;
};
const ids = (value) => (value ?? "").split(/\s+/).filter(Boolean);
const before = (a, b) => index.has(a) && index.has(b) && index.get(a) < index.get(b);

check("0. The files can be read as a log", (p) => {
  p.push(...setupProblems, ...parseProblems);
  for (const e of entries) {
    if (byId.has(e.id)) p.push(`${e.id}: the ID is used twice`);
    byId.set(e.id, e);
  }
  if (entries.length < 10) p.push(`only ${entries.length} entries; at least ten are needed`);
});

check("1. Every entry has exactly one status: decision, proposal or question", (p) => {
  for (const e of entries) {
    const s = status(e);
    if (!Object.hasOwn(FIELDS, s ?? "")) {
      p.push(`${e.id}: status ${JSON.stringify(s ?? "(none)")} is not decision, proposal or question`);
      continue;
    }
    if (!new RegExp(`^${PREFIX[s]}-\\d+$`).test(e.id)) p.push(`${e.id}: a ${s}'s ID is ${PREFIX[s]}- followed by digits`);
    for (const f of FIELDS[s].required) if (!e.fields.has(f)) p.push(`${e.id}: "${f}" is missing`);
    for (const f of e.fields.keys()) if (![...FIELDS[s].required, ...FIELDS[s].optional].includes(f)) p.push(`${e.id}: a ${s} has no "${f}" line`);
  }
});

check("2. A decision records its approver and where it was approved", (p) => {
  const usedBy = new Map(); // approval line -> decision
  for (const e of entries.filter((x) => status(x) === "decision")) {
    const person = e.fields.get("Approver");
    const area = e.fields.get("Area");
    if (!person) {
      p.push(`${e.id}: no approver is recorded`);
      continue;
    }
    if (!approvers.has(person)) p.push(`${e.id}: ${JSON.stringify(person)} is not in rules.md's "Who may approve" table`);
    else if (!approvers.get(person).includes(area)) p.push(`${e.id}: ${person} may not approve area ${JSON.stringify(area ?? "")}`);
    const quote = /^"(.*)"$/.exec(e.fields.get("Approval") ?? "")?.[1];
    if (quote === undefined) {
      p.push(`${e.id}: the Approval must be the approver's line, quoted`);
      continue;
    }
    // In the approver's own words: the quoted line must be "Approved by <approver>: <what>".
    const prefix = `Approved by ${person}: `;
    if (!quote.startsWith(prefix) || quote.length <= prefix.length) {
      p.push(`${e.id}: the quoted line is not an approval by ${person} ("Approved by ${person}: …"); agreement is not an approval`);
    }
    const src = sources.get(e.fields.get("Source"));
    if (src && !src.includes(`- ${quote}`)) p.push(`${e.id}: the approval line isn't in ${e.fields.get("Source")}, word for word`);
    // One approval backs one decision: a decision can't borrow another's approval.
    const key = `${e.fields.get("Source")}\n${quote}`;
    if (usedBy.has(key)) p.push(`${e.id}: uses the same approval as ${usedBy.get(key)}; each approval backs one decision`);
    else usedBy.set(key, e.id);
  }
});

check("3. A proposal is never shown as a decision", (p) => {
  for (const e of entries.filter((x) => status(x) === "proposal" || status(x) === "question")) {
    for (const f of ["Approver", "Approval", "Area"]) if (e.fields.has(f)) p.push(`${e.id}: a ${status(e)} has "${f}", which only a decision has`);
  }
  const view = viewOf(logText);
  if (!view.problem) {
    for (const row of view.inner.split("\n").slice(2)) {
      const id = (cellsOf(row) ?? [])[0];
      const e = byId.get(id);
      if (!e || status(e) !== "decision") p.push(`${id} is in the Current decisions view but is not a decision`);
    }
  }
  for (const [item, rests] of workItems) {
    for (const id of rests) {
      const e = byId.get(id);
      if (!e) p.push(`work item ${item} rests on ${id}, which isn't in the log`);
      else if (status(e) !== "decision") p.push(`work item ${item} rests on ${id}, a ${status(e)}: work must rest on an approved decision`);
    }
  }
});

check("4. Promoting a proposal adds an entry and keeps the history", (p) => {
  for (const e of entries) {
    const from = e.fields.get("From");
    if (from) {
      const src = byId.get(from);
      if (!src) p.push(`${e.id}: From ${from}, which isn't in the log`);
      else {
        if (status(src) === "decision") p.push(`${e.id}: From ${from}, which is already a decision`);
        if (src.fields.get("Became") !== e.id) p.push(`${e.id}: From ${from}, but ${from} doesn't say "Became: ${e.id}"`);
        if (!before(from, e.id)) p.push(`${e.id}: must come after ${from}, which it came from`);
        if (earlier(e.fields.get("Date"), src.fields.get("Date"))) p.push(`${e.id}: dated before ${from}, which it came from`);
      }
    }
    const became = e.fields.get("Became");
    if (became) {
      const to = byId.get(became);
      if (!to) p.push(`${e.id}: Became ${became}, which isn't in the log`);
      else if (to.fields.get("From") !== e.id) p.push(`${e.id}: Became ${became}, but ${became} doesn't say "From: ${e.id}"`);
    }
  }
});

check("5. A replaced decision links to the one that replaced it", (p) => {
  for (const e of entries) {
    const by = e.fields.get("Replaced by");
    if (by) {
      const n = byId.get(by);
      if (!n || status(n) !== "decision") p.push(`${e.id}: Replaced by ${by}, which isn't a decision in the log`);
      else if (n.fields.get("Replaces") !== e.id) p.push(`${e.id}: Replaced by ${by}, but ${by} doesn't say "Replaces: ${e.id}"`);
    }
    const old = e.fields.get("Replaces");
    if (old) {
      const o = byId.get(old);
      if (!o || status(o) !== "decision") p.push(`${e.id}: Replaces ${old}, which isn't a decision in the log`);
      else {
        if (o.fields.get("Replaced by") !== e.id) p.push(`${e.id}: Replaces ${old}, but ${old} doesn't say "Replaced by: ${e.id}"`);
        // A replacement comes after what it replaces: no decision replaces itself, and no loops.
        if (!before(old, e.id)) p.push(`${e.id}: must come after ${old}, which it replaces`);
        if (earlier(e.fields.get("Date"), o.fields.get("Date"))) p.push(`${e.id}: dated before ${old}, which it replaces`);
      }
    }
  }
});

check("6. Each entry cites its source (and its date)", (p) => {
  for (const e of entries) {
    const s = e.fields.get("Source");
    if (s && !sources.has(s)) p.push(`${e.id}: source ${s} isn't in sources.md`);
    if (e.fields.has("Date") && validDate(e.fields.get("Date")) === null) p.push(`${e.id}: date ${JSON.stringify(e.fields.get("Date"))} is not a real MM-DD-YYYY date`);
  }
});

check("7. A reader finds the current decisions without reading the history", (p) => {
  const v = viewOf(logText);
  if (v.problem) p.push(v.problem);
  else if (v.inner !== buildView(entries) && mode !== "write-view") p.push("the Current decisions view doesn't match the entries; run with --write-view");
});

check("Stretch: decisions link to the work items they affect", (p) => {
  for (const e of entries.filter((x) => status(x) === "decision")) {
    const affects = ids(e.fields.get("Affects"));
    if (affects.length === 1 && affects[0] === "none") continue;
    for (const item of affects) {
      if (!workItems.has(item)) p.push(`${e.id}: affects ${item}, which isn't in the work-items table`);
      else if (!e.fields.has("Replaced by") && !workItems.get(item).includes(e.id)) p.push(`${e.id}: affects ${item}, but ${item} doesn't rest on ${e.id}`);
    }
  }
  for (const [item, rests] of workItems) {
    for (const id of rests) {
      const e = byId.get(id);
      if (e && status(e) === "decision" && e.fields.has("Replaced by")) p.push(`work item ${item} rests on ${id}, which was replaced by ${e.fields.get("Replaced by")}`);
      if (e && status(e) === "decision" && !ids(e.fields.get("Affects")).includes(item)) p.push(`work item ${item} rests on ${id}, but ${id} doesn't list it under Affects`);
    }
  }
});

if (previous !== null) {
  check("History: the log was only added to since the earlier copy", (p) => {
    const baseProblems = [];
    const old = parseEntries(lf(readRaw(previous, "the earlier copy of the log")), baseProblems, "the earlier copy");
    if (baseProblems.length || !old.length || new Set(old.map((e) => e.id)).size !== old.length) {
      p.push(`the earlier copy can't be used as a baseline: ${baseProblems[0] ?? (old.length ? "an ID is used twice" : "it has no entries")}`);
      return;
    }
    // The earlier entries must still be the first ones, in the same order.
    old.forEach((o, i) => {
      const n = entries[i];
      if (!n || n.id !== o.id) {
        p.push(`entry ${i + 1} was ${o.id} and is now ${n ? n.id : "missing"}: earlier entries must stay first, in order`);
        return;
      }
      if (n.title !== o.title) p.push(`${o.id}: its title was changed`);
      // Its earlier lines, in order, with only "Became" and "Replaced by" lines added.
      let j = 0;
      for (const line of n.lines) {
        if (j < o.lines.length && line === o.lines[j]) j++;
        else if (!/^(Became|Replaced by): /.test(line)) p.push(`${o.id}: "${line}" was added or changed; only "Became" and "Replaced by" may be added`);
      }
      for (; j < o.lines.length; j++) p.push(`${o.id}: "${o.lines[j]}" was removed, changed or moved`);
    });
  });
}

// ---- report, and the view written only if everything else passes ------------------------------
const failed = results.reduce((n, r) => n + r.problems.length, 0);
if (mode === "write-view") {
  const v = viewOf(logText);
  if (failed || v.problem) {
    console.log("The Current decisions view was NOT written: fix the problems below first.\n");
  } else if (v.inner === buildView(entries)) {
    console.log("Current decisions view already up to date.\n");
  } else {
    // Only the lines between the markers change; the rest of the file keeps its exact bytes,
    // its line endings and its permissions.
    const eol = logRaw.includes("\r\n") ? "\r\n" : "\n";
    const rawLines = logRaw.split(eol);
    const updated = [...rawLines.slice(0, v.start + 1), ...buildView(entries).split("\n"), ...rawLines.slice(v.end)].join(eol);
    const tmp = `${logPath}.${process.pid}.new`;
    let created = false;
    try {
      writeFileSync(tmp, updated, { flag: "wx", mode: 0o600 });
      created = true;
      chmodSync(tmp, statSync(logPath).mode & 0o7777);
      renameSync(tmp, logPath);
      created = false;
      console.log("Current decisions view rewritten from the entries.\n");
    } catch {
      if (created) {
        try { unlinkSync(tmp); } catch { /* left for a person */ }
      }
      console.error("Couldn't write the view.");
      process.exit(2);
    }
  }
}
const count = (s) => entries.filter((e) => status(e) === s).length;
console.log(`Decision log check: ${shownDir} (${entries.length} entries: ${count("decision")} decisions, ${count("proposal")} proposals, ${count("question")} questions)`);
for (const r of results) {
  console.log(`${r.problems.length ? "FAIL" : "PASS"}  ${r.title}`);
  for (const pr of r.problems) console.log(`      - ${pr}`);
}
// Stretch goal 2: decisions in force with no work resting on them.
const idle = entries.filter((e) => status(e) === "decision" && !e.fields.has("Replaced by") && ![...workItems.values()].some((r) => r.includes(e.id)));
console.log(`Decisions in force with no work resting on them: ${idle.length ? idle.map((e) => `${e.id} (${e.title})`).join(", ") : "none"}`);
console.log(failed ? `Result: FAIL, ${failed} problem${failed === 1 ? "" : "s"}.` : "Result: PASS, every check passed.");
process.exitCode = failed ? 1 : 0;
