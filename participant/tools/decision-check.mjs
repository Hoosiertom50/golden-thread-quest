// Checks the decision log for the context-decision-log quest, one acceptance criterion at a time,
// and builds its "Current decisions" view. It reads three files in one folder (default
// participant/context/decisions): log.md (the entries), rules.md (who may approve what) and
// sources.md (the written records the entries cite, and the work items).
//
//   node participant/tools/decision-check.mjs [--dir <folder>] [--previous <earlier log.md>] [--write-view]
//
//   --previous   also checks that nothing in an earlier copy of the log was changed or removed:
//                every earlier entry is still there, word for word, and the only lines added to it
//                are "Became" and "Replaced by" (the log is append-only).
//   --write-view rewrites only the Current decisions list between its two markers, from the
//                entries, then checks the log.
//
// Exit codes: 0 every check passed, 1 at least one problem, 2 a file couldn't be read or the
// arguments were wrong. It never changes anything except, with --write-view, that one list.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

const usage = () => {
  console.error("Usage: node participant/tools/decision-check.mjs [--dir <folder>] [--previous <earlier log.md>] [--write-view]");
  process.exit(2);
};
let dir = "participant/context/decisions";
let previous = null;
let writeView = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && i + 1 < args.length) dir = args[++i];
  else if (args[i] === "--previous" && i + 1 < args.length) previous = args[++i];
  else if (args[i] === "--write-view") writeView = true;
  else usage();
}
// Folders are shown as given, except an absolute one (it could show this computer's folders).
const shownDir = isAbsolute(dir) ? `(folder ${basename(dir)})` : dir;
const read = (path, what) => {
  try {
    return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  } catch {
    console.error(`Couldn't read ${what}.`);
    process.exit(2);
  }
};
const logPath = join(dir, "log.md");
let logText = read(logPath, `${shownDir}/log.md`);
const rulesText = read(join(dir, "rules.md"), `${shownDir}/rules.md`);
const sourcesText = read(join(dir, "sources.md"), `${shownDir}/sources.md`);

// ---- reading the files ----------------------------------------------------------------------
// The lines of the section whose heading (at `level` #'s) starts with `title`.
const section = (text, level, title) => {
  const lines = text.split("\n");
  const mark = `${"#".repeat(level)} `;
  const start = lines.findIndex((l) => l.startsWith(mark) && l.slice(mark.length).startsWith(title));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out;
};
const tableRows = (lines) => (lines ?? [])
  .filter((l) => l.trim().startsWith("|"))
  .slice(2)
  .map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()));
const ticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const setupProblems = [];
// rules.md: who may approve which areas.
const approvers = new Map();
const whoRows = tableRows(section(rulesText, 2, "Who may approve"));
if (!whoRows.length) setupProblems.push('rules.md has no "Who may approve" table');
for (const [name, , areas] of whoRows) approvers.set(name, ticks(areas ?? ""));

// sources.md: each "## ID · title" section, and the work-items table.
const sources = new Map();
for (const m of sourcesText.matchAll(/^## ([A-Z]+-\d+) · .*$/gm)) {
  if (sources.has(m[1])) setupProblems.push(`sources.md has two sections for ${m[1]}`);
  sources.set(m[1], section(sourcesText, 2, `${m[1]} · `).map((l) => l.trim()));
}
const workItems = new Map();
for (const [id, , restsOn] of tableRows(section(sourcesText, 2, "Work items"))) {
  workItems.set(id, (restsOn ?? "").split(/\s+/).filter(Boolean));
}
if (!sources.size) setupProblems.push("sources.md has no sources");

// log.md: the entries under "## Entries", each "### ID · title" with "- Field: value" lines.
const FIELDS = {
  decision: { required: ["Status", "Date", "Source", "Area", "Approver", "Approval", "Affects"], optional: ["From", "Replaces", "Replaced by", "Note"] },
  proposal: { required: ["Status", "Date", "Source", "Proposed by"], optional: ["Became", "Note"] },
  question: { required: ["Status", "Date", "Source", "Asked by"], optional: ["Became", "Note"] },
};
const PREFIX = { decision: "D", proposal: "P", question: "Q" };
const parseEntries = (text, problems) => {
  const entries = [];
  const body = section(text, 2, "Entries");
  if (!body) {
    problems.push('there is no "## Entries" section');
    return entries;
  }
  let cur = null;
  for (const line of body) {
    const h = /^### (\S+) · (.+)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), fields: new Map(), order: [] };
      entries.push(cur);
      continue;
    }
    if (line.trim() === "") continue;
    if (!cur) {
      problems.push(`a line before the first entry: ${JSON.stringify(line)}`);
      continue;
    }
    const f = /^- ([A-Za-z ]+?): (.*)$/.exec(line);
    if (!f) {
      problems.push(`${cur.id}: a line that isn't "- Field: value": ${JSON.stringify(line)}`);
      continue;
    }
    if (cur.fields.has(f[1])) problems.push(`${cur.id}: "${f[1]}" is given twice`);
    cur.fields.set(f[1], f[2].trim());
    cur.order.push(f[1]);
  }
  return entries;
};

// ---- the current-decisions view --------------------------------------------------------------
const START = "<!-- current-decisions: start -->";
const END = "<!-- current-decisions: end -->";
const buildView = (entries) => {
  const live = entries.filter((e) => e.fields.get("Status") === "decision" && !e.fields.has("Replaced by"));
  const cell = (v) => String(v ?? "").replace(/\|/g, "\\|");
  const rows = live.map((e) => `| ${e.id} | ${cell(e.title)} | ${e.fields.get("Area")} | ${e.fields.get("Approver")} | ${e.fields.get("Date")} | ${e.fields.get("Source")} |`);
  return ["| Decision | What was decided | Area | Approved by | Date | Where |", "|---|---|---|---|---|---|", ...rows].join("\n");
};
const viewOf = (text) => {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a || text.indexOf(START, a + 1) !== -1 || text.indexOf(END, b + 1) !== -1) return null;
  return { a, b, inner: text.slice(a + START.length, b).trim() };
};

const parseProblems = [];
let entries = parseEntries(logText, parseProblems);
if (writeView) {
  const v = viewOf(logText);
  if (!v) {
    console.error("Can't write the view: log.md needs exactly one pair of current-decisions markers.");
    process.exit(2);
  }
  const updated = `${logText.slice(0, v.a + START.length)}\n${buildView(entries)}\n${logText.slice(v.b)}`;
  if (updated !== logText) {
    const tmp = `${logPath}.${process.pid}.new`;
    try {
      writeFileSync(tmp, updated, { flag: "wx" });
      renameSync(tmp, logPath);
    } catch {
      try { unlinkSync(tmp); } catch { /* not created */ }
      console.error("Couldn't write the view.");
      process.exit(2);
    }
    logText = updated;
    console.log("Current decisions view rewritten from the entries.\n");
  } else console.log("Current decisions view already up to date.\n");
}

// ---- the checks -------------------------------------------------------------------------------
const byId = new Map();
const results = [];
const check = (title, fn) => {
  const problems = [];
  fn(problems);
  results.push({ title, problems });
};
const status = (e) => e.fields.get("Status");
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
    if (!FIELDS[s]) {
      p.push(`${e.id}: status ${JSON.stringify(s ?? "(none)")} is not decision, proposal or question`);
      continue;
    }
    if (!e.id.startsWith(`${PREFIX[s]}-`)) p.push(`${e.id}: a ${s}'s ID starts with ${PREFIX[s]}-`);
    for (const f of FIELDS[s].required) if (!e.fields.has(f) || e.fields.get(f) === "") p.push(`${e.id}: "${f}" is missing`);
    for (const f of e.fields.keys()) if (![...FIELDS[s].required, ...FIELDS[s].optional].includes(f)) p.push(`${e.id}: a ${s} has no "${f}" line`);
  }
});

check("2. A decision records its approver and where it was approved", (p) => {
  for (const e of entries.filter((x) => status(x) === "decision")) {
    const who = e.fields.get("Approver");
    const area = e.fields.get("Area");
    const quote = /^"(.*)"$/.exec(e.fields.get("Approval") ?? "")?.[1];
    if (!who) {
      p.push(`${e.id}: no approver is recorded`);
      continue;
    }
    if (!approvers.has(who)) p.push(`${e.id}: ${JSON.stringify(who ?? "")} is not in rules.md's "Who may approve" table`);
    else if (!approvers.get(who).includes(area)) p.push(`${e.id}: ${who} may not approve area ${JSON.stringify(area ?? "")}`);
    if (quote === undefined) {
      p.push(`${e.id}: the Approval must be the approver's line, quoted`);
      continue;
    }
    // In the approver's own words: the quoted line must start "Approved by <approver>:".
    if (!quote.startsWith(`Approved by ${who}:`)) p.push(`${e.id}: the quoted line is not an approval by ${who} ("Approved by ${who}: …"); agreement is not an approval`);
    const src = sources.get(e.fields.get("Source"));
    if (src && !src.includes(`- ${quote}`)) p.push(`${e.id}: the approval line isn't in ${e.fields.get("Source")}, word for word`);
  }
});

check("3. A proposal is never shown as a decision", (p) => {
  for (const e of entries.filter((x) => status(x) === "proposal" || status(x) === "question")) {
    for (const f of ["Approver", "Approval", "Area"]) if (e.fields.has(f)) p.push(`${e.id}: a ${status(e)} has "${f}", which only a decision has`);
  }
  const view = viewOf(logText);
  if (view) {
    for (const m of view.inner.matchAll(/^\| ([A-Z]-\d+) \|/gm)) {
      const e = byId.get(m[1]);
      if (!e || status(e) !== "decision") p.push(`${m[1]} is in the Current decisions view but is not a decision`);
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
  if (!v) p.push("log.md needs exactly one pair of current-decisions markers");
  else if (v.inner !== buildView(entries)) p.push("the Current decisions view doesn't match the entries; run with --write-view");
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
  check("History: nothing in the earlier copy was changed or removed", (p) => {
    const earlierText = read(previous, "the earlier copy of the log");
    const earlierEntries = parseEntries(earlierText, []);
    const now = new Map(entries.map((e) => [e.id, e]));
    for (const o of earlierEntries) {
      const n = now.get(o.id);
      if (!n) {
        p.push(`${o.id} was removed`);
        continue;
      }
      if (n.title !== o.title) p.push(`${o.id}: its title was changed`);
      for (const [f, v] of o.fields) {
        if (!n.fields.has(f)) p.push(`${o.id}: "${f}" was removed`);
        else if (n.fields.get(f) !== v) p.push(`${o.id}: "${f}" was changed (was ${JSON.stringify(v)}, now ${JSON.stringify(n.fields.get(f))})`);
      }
      for (const f of n.fields.keys()) {
        if (!o.fields.has(f) && f !== "Became" && f !== "Replaced by") p.push(`${o.id}: "${f}" was added; only "Became" and "Replaced by" may be added to an existing entry`);
      }
    }
  });
}

// ---- report -----------------------------------------------------------------------------------
const count = (s) => entries.filter((e) => status(e) === s).length;
console.log(`Decision log check: ${shownDir} (${entries.length} entries: ${count("decision")} decisions, ${count("proposal")} proposals, ${count("question")} questions)`);
let failed = 0;
for (const r of results) {
  console.log(`${r.problems.length ? "FAIL" : "PASS"}  ${r.title}`);
  for (const pr of r.problems) console.log(`      - ${pr}`);
  failed += r.problems.length;
}
// Stretch goal 2: decisions in force with no work resting on them.
const idle = entries.filter((e) => status(e) === "decision" && !e.fields.has("Replaced by") && ![...workItems.values()].some((r) => r.includes(e.id)));
console.log(`Decisions in force with no work resting on them: ${idle.length ? idle.map((e) => `${e.id} (${e.title})`).join(", ") : "none"}`);
console.log(failed ? `Result: FAIL, ${failed} problem${failed === 1 ? "" : "s"}.` : "Result: PASS, every check passed.");
process.exitCode = failed ? 1 : 0;
