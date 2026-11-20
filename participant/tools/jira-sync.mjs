// Synchronizes the Jira stories assigned to the authenticated user into local files, for the
// jira-read-assigned-stories quest. Read-only towards Jira. In this repository it only ever talks
// to the pretend Jira (participant/tools/fake-jira.mjs) serving one of the quest's practice data
// sets; it never connects to a real Jira.
//
//   node participant/tools/jira-sync.mjs --fixture <name> [--phase previous|current] [--out <folder>]
//
//   --fixture  happy-path, pagination, stale-item or duplicate-comment
//   --phase    "previous" serves the stale-item set as it was on the earlier run (default current)
//   --out      where the synchronized files go (default participant/context/jira/assigned in this
//              repository, wherever it is run from)
//
// What it writes into <folder>, each replaced whole (a new file, renamed into place):
//   stories.json        the normalized stories, and the stories that stopped being assigned
//   index.md            a readable index of the same
//   sync-summary.json   what this run did: pages read, totals, new, changed, removed
// and, for a story seen for the first time, an empty notes file notes/<KEY>.md, created only if
// none exists. It never opens an existing notes file for writing: notes belong to the person.
//
// How a run works:
//   1. Ask Jira who the authenticated user is (myself); nothing about the user is hard-coded.
//   2. Search for stories assigned to that user, page after page, until Jira says isLast (and
//      the stories counted match Jira's total). A story assigned to anyone else is not kept.
//   3. Read each story's comments, page after page, keeping each comment id once.
//   4. Normalize each story; keep Jira-only fields under "jira_fields", apart from the normal ones.
//   5. Merge with the previous stories.json by key: a story no longer returned is moved to
//      "removed" with its last known state, never deleted; a story that comes back leaves it.
//
// Exit codes: 0 synchronized, 1 incomplete or unexpected answer from Jira (paging that doesn't add
// up, a key that isn't a Jira key; nothing was written), 2 usage, file or other error.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, fakeJira } from "./fake-jira.mjs";

// Anything unexpected (a file that can't be read or written) is exit 2, never 1, which means
// "Jira's answer was incomplete".
process.on("uncaughtException", (err) => {
  console.error(`Stopped: ${err.message}`);
  process.exit(2);
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SITE = "https://jira.example.invalid";
// The search, as it would be sent to Jira: stories assigned to whoever is signed in.
export const JQL = "assignee = currentUser() AND issuetype = Story ORDER BY key ASC";

const usage = () => {
  console.error("Usage: node participant/tools/jira-sync.mjs --fixture <happy-path|pagination|stale-item|duplicate-comment> [--phase previous|current] [--out <folder>]");
  process.exit(2);
};
let fixture = null;
let phase = "current";
let out = join(REPO, "participant", "context", "jira", "assigned");
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fixture" && i + 1 < args.length) fixture = args[++i];
  else if (args[i] === "--phase" && i + 1 < args.length) phase = args[++i];
  else if (args[i] === "--out" && i + 1 < args.length) out = args[++i];
  else usage();
}
if (!FIXTURES.includes(fixture) || !["previous", "current"].includes(phase)) usage();

const jira = fakeJira({ fixturesDir: join(REPO, "validators", "fixtures", "jira"), fixture, phase });
const nowDate = new Date();
const now = nowDate.toISOString(); // machine fields keep ISO 8601
// For people: MM-DD-YYYY and a 12-hour time, in this computer's time zone.
const shownTime = (d) => {
  const p2 = (n) => String(n).padStart(2, "0");
  const h = d.getHours() % 12 || 12;
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${d.getFullYear()} ${h}:${p2(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
};

// ---- 1. who am I ------------------------------------------------------------------------------
const me = jira.myself();
// Without a known account every story would look "not mine" and be moved to removed: stop instead.
if (typeof me?.accountId !== "string" || me.accountId === "") {
  console.error("Incomplete: Jira didn't say who is signed in; nothing was written.");
  process.exit(1);
}

// ---- 2. every assigned story, page after page ------------------------------------------------
// Stop on anything that would make the local copy incomplete or unsafe; nothing is written.
const incomplete = (why) => {
  console.error(`Incomplete: ${why}; nothing was written.`);
  process.exit(1);
};
// A Jira key: project letters, a hyphen, a number. Keys become file names, so nothing else passes.
const KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
const issues = [];
let pages = 0;
let total = null;
let startAt = 0;
for (;;) {
  const page = jira.searchAssigned({ startAt, maxResults: 50 });
  pages++;
  total = page.total;
  if (!Number.isInteger(total) || total < 0) incomplete(`page ${pages} gave no usable total`);
  issues.push(...page.issues);
  // More than Jira said it has: it is repeating itself, so stop rather than loop forever.
  if (issues.length > total) incomplete(`Jira reported ${total} stories but sent more (${issues.length} after page ${pages})`);
  if (page.isLast) break;
  // Jira says there is more but sent nothing: stop rather than loop.
  if (page.issues.length === 0) incomplete(`Jira reported ${total} stories but page ${pages} was empty`);
  startAt += page.issues.length;
}
const keys = issues.map((i) => i.key);
if (issues.length !== total || new Set(keys).size !== keys.length) {
  incomplete(`Jira reported ${total} stories, ${issues.length} arrived (${new Set(keys).size} distinct)`);
}
const badKey = keys.find((k) => typeof k !== "string" || !KEY.test(k));
if (badKey !== undefined) incomplete(`Jira returned ${JSON.stringify(badKey)}, which is not a Jira key`);
const mine = issues.filter((i) => i.fields.assignee?.accountId === me.accountId);
const notMine = issues.filter((i) => i.fields.assignee?.accountId !== me.accountId).map((i) => i.key);

// ---- 3. comments, each id once ----------------------------------------------------------------
let duplicateComments = 0;
const commentsOf = (key) => {
  const seen = new Map();
  let at = 0;
  let pageNo = 0;
  for (;;) {
    const page = jira.comments(key, { startAt: at });
    pageNo++;
    for (const c of page.comments) {
      if (seen.has(c.id)) duplicateComments++;
      else seen.set(c.id, { id: c.id, author: c.author?.displayName ?? null, body: c.body });
    }
    at += page.comments.length;
    // The same rules as the stories: every comment Jira counts must arrive, and no more.
    if (!Number.isInteger(page.total) || at > page.total) incomplete(`${key}'s comments don't add up (Jira reported ${page.total}, ${at} arrived)`);
    if (page.isLast) {
      if (at !== page.total) incomplete(`Jira reported ${page.total} comments on ${key}, ${at} arrived`);
      break;
    }
    if (page.comments.length === 0) incomplete(`Jira reported ${page.total} comments on ${key} but comment page ${pageNo} was empty`);
  }
  return [...seen.values()];
};

// ---- 4. normalize -----------------------------------------------------------------------------
const NORMAL = new Set(["summary", "status", "priority", "assignee", "labels", "description", "parent", "created", "updated", "issuetype"]);
const normalize = (i) => ({
  key: i.key,
  source_url: `${SITE}/browse/${i.key}`,
  summary: i.fields.summary,
  status: i.fields.status?.name ?? null,
  priority: i.fields.priority?.name ?? null,
  type: i.fields.issuetype?.name ?? null,
  assignee: i.fields.assignee ? { account_id: i.fields.assignee.accountId, display_name: i.fields.assignee.displayName } : null,
  labels: i.fields.labels ?? [],
  description: i.fields.description ?? null,
  // Jira has no acceptance-criteria field of its own; a project that keeps them in a custom
  // field would map it here. None of the practice data has one.
  acceptance_criteria: null,
  parent: i.fields.parent?.key ?? null,
  created: i.fields.created ?? null,
  updated: i.fields.updated ?? null,
  retrieved_at: now,
  comments: commentsOf(i.key),
  jira_fields: Object.fromEntries(Object.entries(i.fields).filter(([k]) => !NORMAL.has(k))),
});
const stories = mine.map(normalize);

// ---- 5. merge with the previous run -----------------------------------------------------------
const storiesPath = join(out, "stories.json");
let before = { stories: [], removed: [] };
if (existsSync(storiesPath)) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(storiesPath, "utf8"));
  } catch {
    parsed = undefined;
  }
  // It must look like this tool's own output: an object with a list of stories and of removed
  // ones, each with a key. Anything else is left for a person to look at.
  const okList = (l) => l === undefined || (Array.isArray(l) && l.every((x) => x && typeof x === "object" && typeof x.key === "string"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !okList(parsed.stories) || !okList(parsed.removed)) {
    console.error("The previous stories.json isn't one this tool wrote; nothing was written. Fix or move it, then run again.");
    process.exit(2);
  }
  before = parsed;
}
const nowKeys = new Set(stories.map((s) => s.key));
const prevByKey = new Map((before.stories ?? []).map((s) => [s.key, s]));
const comparable = (s) => JSON.stringify({ ...s, retrieved_at: null });
const added = stories.filter((s) => !prevByKey.has(s.key)).map((s) => s.key);
const changed = stories.filter((s) => prevByKey.has(s.key) && comparable(prevByKey.get(s.key)) !== comparable(s)).map((s) => s.key);
// Gone now: kept, with its last known state. Already-removed stories stay removed until they
// come back.
const newlyRemoved = (before.stories ?? []).filter((s) => !nowKeys.has(s.key)).map((s) => ({
  key: s.key,
  last_known_status: s.status,
  last_known_summary: s.summary,
  source_url: s.source_url,
  removed_at: now,
  reason: notMine.includes(s.key) ? "assigned to someone else" : "no longer returned for the authenticated user",
}));
const stillRemoved = (before.removed ?? []).filter((r) => !nowKeys.has(r.key) && !newlyRemoved.some((n) => n.key === r.key));
const removed = [...stillRemoved, ...newlyRemoved].sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
const returned = (before.removed ?? []).filter((r) => nowKeys.has(r.key)).map((r) => r.key);

// ---- writing ----------------------------------------------------------------------------------
// Each file is written to a new temporary name and renamed into place, so a reader never sees a
// half-written file. Notes files are created only when missing ("wx"), never rewritten.
const writeWhole = (path, text) => {
  const tmp = `${path}.${process.pid}.new`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    try {
      const bytes = Buffer.from(text, "utf8");
      let done = 0;
      while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
};
mkdirSync(join(out, "notes"), { recursive: true });
const notesCreated = [];
for (const s of stories) {
  const notePath = join(out, "notes", `${s.key}.md`);
  try {
    const fd = openSync(notePath, "wx", 0o644);
    try {
      writeSync(fd, `# Notes: ${s.key}\n\nYour own notes on ${s.key}. The synchronization never changes this file.\n`);
    } finally {
      closeSync(fd);
    }
    notesCreated.push(s.key);
  } catch (err) {
    if (err.code !== "EEXIST") throw err; // an existing notes file is left exactly as it is
  }
}

const summary = {
  retrieved_at: now,
  practice_set: fixture,
  phase,
  account: { account_id: me.accountId, display_name: me.displayName },
  query: JQL,
  pages_read: pages,
  total_reported_by_jira: total,
  stories_received: issues.length,
  complete: issues.length === total,
  stories: stories.length,
  new: added,
  changed,
  unchanged: stories.filter((s) => !added.includes(s.key) && !changed.includes(s.key)).map((s) => s.key),
  removed_this_run: newlyRemoved.map((r) => r.key),
  returned_this_run: returned,
  removed_total: removed.length,
  not_assigned_to_me: notMine,
  duplicate_comments_skipped: duplicateComments,
  notes_created: notesCreated,
};

// Ticket text is shown, never trusted: line breaks become spaces so one cell can't break the table.
const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const row = (cells) => `| ${cells.map((c) => oneLine(c).replace(/\|/g, "\\|")).join(" | ")} |`;
const index = [
  "# My assigned Jira stories",
  "",
  `Generated by \`participant/tools/jira-sync.mjs\` from the practice data set "${fixture}" (${phase} state), not a real Jira. Do not edit: it is rewritten on every run. Your own notes go in \`notes/<KEY>.md\`, which the synchronization never changes.`,
  "",
  `- Signed-in user (asked of Jira, not assumed): ${oneLine(me.displayName)}`,
  `- Query: \`${JQL}\``,
  `- Pages read: ${pages}; Jira reported ${total} stories and ${issues.length} arrived, so the list is ${summary.complete ? "complete" : "INCOMPLETE"}.`,
  `- Retrieved: ${shownTime(nowDate)}`,
  "",
  "## Assigned",
  "",
  row(["Key", "Summary", "Status", "Comments", "Notes"]),
  row(["---", "---", "---", "---", "---"]),
  ...stories.map((s) => row([s.key, s.summary, s.status, s.comments.length, `notes/${s.key}.md`])),
  "",
  "## No longer assigned",
  "",
  ...(removed.length
    ? [row(["Key", "Last known summary", "Last known status", "Removed at", "Notes"]), row(["---", "---", "---", "---", "---"]), ...removed.map((r) => row([r.key, r.last_known_summary, r.last_known_status, shownTime(new Date(r.removed_at)), `notes/${r.key}.md (kept)`]))]
    : ["None."]),
  "",
].join("\n");

writeWhole(storiesPath, `${JSON.stringify({ synchronized_at: now, account_id: me.accountId, stories, removed }, null, 2)}\n`);
writeWhole(join(out, "index.md"), index);
writeWhole(join(out, "sync-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`Synchronized "${fixture}" (${phase}): ${pages} page(s), Jira reported ${total}, received ${issues.length}, complete: ${summary.complete}.`);
console.log(`  stories: ${stories.length} (new ${added.length}, changed ${changed.length}, unchanged ${summary.unchanged.length}); removed this run: ${newlyRemoved.map((r) => r.key).join(", ") || "none"}; still removed: ${removed.length}`);
console.log(`  duplicate comments skipped: ${duplicateComments}; notes files created: ${notesCreated.join(", ") || "none"} (existing notes untouched)`);
