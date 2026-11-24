#!/usr/bin/env node
// Normalize the local Jira and GitHub copies into canonical work items (model version 1,
// participant/context/model/work-item.md). It only reads the synchronized copies; it never
// contacts Jira or GitHub and never writes to their folders.
//
//   node participant/tools/normalize-work-items.mjs [--jira <stories.json>] [--github <sync-state.json>]
//                                                    [--model <folder>]
//
// Defaults: participant/context/jira/assigned/stories.json,
// participant/context/github/assigned/sync-state.json, participant/context/model.
// Writes <model>/items/<system>__<identifier>.md (one per item), <model>/items/index.md,
// <model>/identity.json and <model>/examples.md.
//
// Exit 0: every item represented and current. Exit 2: the run finished, but one or more items were
// not represented (each reported with its reason; none written as a partial record), or an earlier
// record was kept and marked "Not refreshed". Exit 1: the run
// stopped (bad input, a lock, a write error); see the message for what was written.

import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_VERSION = 1;
// Times are shown in one fixed zone, so a re-run on another computer doesn't rewrite every record.
process.env.TZ = "America/New_York";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "## My analysis";
const MARKER_BYTES = Buffer.from(MARKER);
const STATUSES = ["todo", "in_progress", "done", "cancelled"];

let jiraPath = join(ROOT, "participant/context/jira/assigned/stories.json");
let githubPath = join(ROOT, "participant/context/github/assigned/sync-state.json");
let modelDir = join(ROOT, "participant/context/model");
let lockPath = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--jira" && i + 1 < args.length) jiraPath = resolve(args[++i]);
  else if (args[i] === "--github" && i + 1 < args.length) githubPath = resolve(args[++i]);
  else if (args[i] === "--model" && i + 1 < args.length) modelDir = resolve(args[++i]);
  else fail(`unknown argument ${JSON.stringify(args[i])}`);
}
const itemsDir = join(modelDir, "items");
process.on("uncaughtException", (e) => fail(`unexpected error (${String(e?.message).slice(0, 120)})`));

function fail(message) {
  if (lockPath) { try { unlinkSync(lockPath); } catch {} }
  console.error(`Stopped: ${String(message).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g, " ").slice(0, 300)}; ${wroteAnything ? "some files were written before it (each one whole); run again to finish" : "nothing was written"}.`);
  process.exit(1);
}

// ---- helpers ------------------------------------------------------------------------------------

const isText = (v) => typeof v === "string";
class Code { constructor(v) { this.v = v; } } // only for identifiers this program has validated
// An ISO time that is a real calendar moment (no rolled-over dates such as February 30).
function isTime(v) {
  if (!isText(v)) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(v);
  if (!m || Number.isNaN(Date.parse(v))) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const at = new Date(v).getUTCFullYear(), local = new Date(v).getFullYear();
  if (y < 1970 || y > 9998 || at < 1970 || at > 9998 || local < 1970 || local > 9998) return false;
  const c = new Date(0); c.setUTCFullYear(y, mo - 1, d);
  return c.getUTCFullYear() === y && c.getUTCMonth() === mo - 1 && c.getUTCDate() === d && h < 24 && mi < 60 && s < 60;
}
// Untrusted text, shown as text: one line, Markdown and HTML characters escaped, and web addresses
// broken so a viewer won't make them links.
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u2800\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const text = (v) => String(v)
  .replace(CONTROL, "")
  .replace(/[\r\n\t\u000b\u000c\u0085\u2028\u2029]+/g, " ")
  .replace(/[\\`*_\[\]#|<>~&()!=@]/g, (c) => "\\" + c)
  .replace(/:\/\//g, ":\\/\\/")
  .replace(/www\./gi, (w) => w.slice(0, 3) + "\\.");
const pad = (n) => String(n).padStart(2, "0");
function shown(iso, raw = false) {
  if (iso === undefined || iso === null) return "none";
  if (!isText(iso)) return "not a valid time (a structured value, not carried)";
  if (!isTime(iso)) return raw ? `not a valid time (${oneLine(iso).slice(0, 60)})` : `not a valid time (${text(iso.slice(0, 60))})`;
  const d = new Date(iso);
  const h = d.getHours();
  const zone = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()} ${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"} ${zone} (${iso})`;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fileFor = (id) => `${id.replace(":", "__")}.md`;
const ID_RE = /^(jira|github):[A-Za-z0-9_=-]{1,100}$/;
const safeId = (id) => isText(id) && ID_RE.test(id);
const NODE_RE = /^[A-Za-z0-9_=-]{1,100}$/;
const KEY_RE = /^(?=.{3,95}$)[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/; // the GitHub synchronization's own rule
const REPO_RE = { test: (v) => isText(v) && v.split("/").length === 2 && v.split("/").every((x) => NAME_RE.test(x)) };
const URL_RE = /^https:\/\/[A-Za-z0-9._~:\/?#@$&'*+,;=%-]+$/;
// A source value carried into a record: plain values as they are, anything structured not carried
// (it could hide names or anything else the model doesn't define).
const STRUCT = "a structured value (not carried)";
const said = (v) => (isText(v) ? JSON.stringify(oneLine(v).slice(0, 40)) : v === undefined || v === null ? String(v) : STRUCT);
const plain = (v) => (v === undefined || v === null || ["string", "number", "boolean"].includes(typeof v) ? v : Array.isArray(v) ? v.map((x) => (x !== null && typeof x === "object" ? STRUCT : x)) : STRUCT);
const oneLine = (s) => String(s).replace(CONTROL, "").replace(/[\s\u0080-\u009f]+/g, " ");

function readJson(path, what) {
  let st;
  try { st = lstatSync(path); } catch { fail(`the ${what} (${path}) doesn't exist`); }
  if (!st.isFile()) fail(`the ${what} (${path}) isn't an ordinary file`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { fail(`the ${what} isn't valid JSON (${e.message})`); }
}

// ---- 1. read the synchronized copies (read only) --------------------------------------------------

const jira = readJson(jiraPath, "Jira copy");
if (!jira || typeof jira !== "object" || !Array.isArray(jira.stories) || !Array.isArray(jira.removed) || !isTime(jira.synchronized_at)) fail("the Jira copy doesn't have stories, removed and synchronized_at");
const jiraSummaryPath = join(dirname(jiraPath), "sync-summary.json");
if (!existsSync(jiraSummaryPath)) fail("the Jira copy has no run summary (sync-summary.json beside it), so its completeness can't be checked");
const jiraSummary = readJson(jiraSummaryPath, "Jira run summary");
if (!jiraSummary || jiraSummary.complete !== true) fail("the Jira run summary doesn't say the synchronization was complete");
if (jiraSummary.retrieved_at !== jira.synchronized_at) fail("the Jira run summary is from a different run than the Jira copy");
const jiraSet = jiraSummary?.practice_set;
const jiraRun = `${isText(jira.test_copy) ? "TEST COPY constructed from " : ""}jira-sync, run of ${shown(jira.synchronized_at, true)}${isText(jiraSet) && /^[A-Za-z0-9_-]{1,40}$/.test(jiraSet) ? `, practice set ${jiraSet}` : ""}`;

const gh = readJson(githubPath, "GitHub copy");
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
if (!isMap(gh) || gh.tool !== "github-sync" || !isMap(gh.issues) || !isMap(gh.no_longer_assigned) || !isTime(gh.synchronized_at)) fail("the GitHub copy doesn't have issues, no_longer_assigned and synchronized_at");
if (!isMap(gh.summary) || gh.summary.complete !== true) fail("the GitHub copy's summary doesn't say the synchronization was complete");
const ghRun = `github-sync, run of ${shown(gh.synchronized_at, true)}`;

// Where the signed-in account stands for a person, it is written "me" (Tom's choice); it stays in
// addresses and links, which provenance needs.
const ME = "me (the signed-in account)";
const OTHER = "another account (name not carried)";
// A repository address is carried when the repository is in the scope list (chosen by the person) or
// owned by the signed-in account; an address found only in a link, outside both, is withheld.
const scopeSet = new Set((Array.isArray(gh.scope) ? gh.scope : []).filter(isText).map((r) => r.toLowerCase()));
const mine = (repo) => isText(repo) && (scopeSet.has(repo.toLowerCase()) || (isText(gh.identity?.login) && repo.split("/")[0].toLowerCase() === gh.identity.login.toLowerCase()));
const ghMe = (login) => (login === undefined || login === null ? login : isText(login) && login === gh.identity?.login ? ME : OTHER);
const jiraMe = (a) => (a === undefined || a === null ? a : isMap(a) && isText(jira.account_id) && a.account_id === jira.account_id ? ME : OTHER);

// ---- 2. map each source item (nothing is guessed) ---------------------------------------------------

const JIRA_STATUS = { "To Do": "todo", "In Progress": "in_progress", Done: "done" };
function githubStatus(state, reason) {
  if (state === "open" && (reason === null || reason === undefined || reason === "reopened")) return "todo";
  if (state === "closed" && (reason === "completed" || reason === null || reason === undefined)) return "done";
  if (state === "closed" && (reason === "not_planned" || reason === "duplicate")) return "cancelled";
  return undefined;
}

const candidates = [];
const refused = [];   // { label, reason, ids }
function rawIds(system, it) {
  try {
    if (system === "jira") return [...new Set([it?.key, ...(Array.isArray(it?.extra_ids) ? it.extra_ids : [])].filter((k) => isText(k) && KEY_RE.test(k)).map((k) => `jira:${k}`))];
    const prev = Array.isArray(it?.previous_node_ids) ? it.previous_node_ids : [];
    const extra = Array.isArray(it?.extra_ids) ? it.extra_ids : [];
    return [...new Set([...prev, it?.node_id, ...extra].filter((n) => isText(n) && NODE_RE.test(n)).map((n) => `github:${n}`))];
  } catch { return []; }
}
const lastOf = (r, idKey) => {
  const k = r?.last_known_record;
  if (!isMap(k)) return { [idKey]: r?.[idKey] };
  return k[idKey] === r?.[idKey] ? k : { [idKey]: r?.[idKey], extra_ids: [k[idKey], ...(Array.isArray(k.previous_node_ids) ? k.previous_node_ids : [])], mismatch: true };
};
const jiraRaw = [...jira.stories.map((s) => [s, true, null]), ...jira.removed.map((r) => [lastOf(r, "key"), false, r])];
const ghRaw = [...Object.entries(gh.issues).map(([k, i]) => [k === i?.node_id ? i : { ...(isMap(i) ? i : {}), node_id: isText(i?.node_id) ? i.node_id : k, extra_ids: [k], mismatch: true }, null]), ...Object.entries(gh.no_longer_assigned).map(([k, r]) => [k === r?.node_id ? lastOf(r, "node_id") : { node_id: r?.node_id, extra_ids: [k], mismatch: true }, r])];
const idCount = new Map();
for (const [it] of jiraRaw) for (const x of rawIds("jira", it)) idCount.set(x, (idCount.get(x) ?? 0) + 1);
for (const [it] of ghRaw) for (const x of rawIds("github", it)) idCount.set(x, (idCount.get(x) ?? 0) + 1);
function mapOne(system, it, fn) {
  const ids = rawIds(system, it);
  const label = `${system === "jira" ? "Jira" : "GitHub"} ${ids.length ? ids[ids.length - 1].split(":")[1] : "(no valid identifier)"}`;
  if (ids.some((x) => idCount.get(x) > 1)) return refused.push({ label, reason: "appears more than once in the synchronized copies; no copy is used", ids, disputed: true });
  try { fn(); } catch (e) {
    if (ids.length) candidates.push({ system, ids, label, refusal: `couldn't be read (${oneLine(e?.message).slice(0, 80)})` });
    else refused.push({ label, reason: `couldn't be read (${oneLine(e?.message).slice(0, 80)})`, ids });
  }
}

function jiraItem(s, assigned, leaving) {
  const label = `Jira ${isText(s?.key) && KEY_RE.test(s.key) ? s.key : "(no valid key)"}`;
  if (!s || typeof s !== "object" || !isText(s.key) || !KEY_RE.test(s.key)) return refused.push({ label, reason: "no valid key", ids: [] });
  if (s.mismatch) return candidates.push({ system: "jira", ids: rawIds("jira", s), label, disputed: true, refusal: "its entry and its last known record name different stories; not guessed" });
  const status = isText(s.status) && Object.hasOwn(JIRA_STATUS, s.status) ? JIRA_STATUS[s.status] : undefined;
  if (!status) return candidates.push({ system: "jira", ids: [`jira:${s.key}`], label, refusal: `status ${said(s.status)} isn't in the Jira mapping` });
  const { key, source_url, summary, type, labels, created, updated, retrieved_at, parent, ...rest } = s;
  const JIRA_REASONS = { "no longer returned for the authenticated user": "no longer returned for the authenticated user", "assigned to someone else": "returned by the search, but not assigned to me (to another account or to no one; name not carried)" };
  const note = leaving && isText(leaving.reason) && Object.hasOwn(JIRA_REASONS, leaving.reason) && isTime(leaving.removed_at) ? `${JIRA_REASONS[leaving.reason]}; noticed ${shown(leaving.removed_at, true)}` : undefined;
  candidates.push({
    system: "jira", ids: [`jira:${key}`], label,
    record: {
      title: summary, status, blocked: "unknown",
      assigned_to_me: assigned ? "yes" : "no",
      assignment_note: note,
      status_as_of: retrieved_at,
      type: isText(type) ? type : undefined, labels: plain(labels), created, updated, closed: undefined,
      related: parent ? [isText(parent) ? `Jira parent ${parent}` : `Jira parent: ${STRUCT}`] : [],
      delivery_evidence: undefined,
      provenance: { source_system: "jira", source_id: key, source_url, retrieved_at, sync_run: jiraRun },
      source: { priority: plain(rest.priority), status: s.status, [leaving ? "assignee (last known)" : "assignee"]: jiraMe(rest.assignee), parent: parent === undefined || parent === null ? "none" : plain(parent), description: rest.description, acceptance_criteria: rest.acceptance_criteria, comments: Array.isArray(rest.comments) ? `${rest.comments.length} in the synchronized copy (not copied)` : undefined, ...Object.fromEntries(Object.entries(isMap(rest.jira_fields) ? rest.jira_fields : {}).map(([k, v]) => [`jira_fields.${k}`, plain(v)])) },
    },
  });
}
for (const [s, assigned, leaving] of jiraRaw) mapOne("jira", s, () => jiraItem(s, assigned, leaving));

function githubItem(i, leaving) {
  const where = i && isText(i.repository) && REPO_RE.test(i.repository) && Number.isInteger(i.number) && i.number > 0;
  const label = `GitHub ${where && mine(i.repository) ? `${i.repository}#${i.number}` : where ? "(repository outside the scope list)" : "(no valid address)"}`;
  if (!i || !isText(i.node_id) || !NODE_RE.test(i.node_id)) return refused.push({ label, reason: "no valid node ID", ids: [] });
  const previous = Array.isArray(i.previous_node_ids) ? i.previous_node_ids : [];
  if (!previous.every((n) => isText(n) && NODE_RE.test(n))) return candidates.push({ system: "github", ids: [`github:${i.node_id}`], label, refusal: "a previous node ID isn't a valid node ID" });
  const ids = [...previous, i.node_id].map((n) => `github:${n}`);
  if (i.mismatch) return candidates.push({ system: "github", ids: [...new Set([...ids, ...rawIds("github", i)])], label, disputed: true, refusal: "its entry's key, content or last known record name different issues; not guessed" });
  if (!where) return candidates.push({ system: "github", ids, label, refusal: "no valid repository and number" });
  if (!mine(i.repository)) return candidates.push({ system: "github", ids, label: "GitHub (repository outside the scope list)", refusal: "its repository isn't in the scope list or the signed-in account's; not carried" });
  const status = githubStatus(i.state, i.state_reason);
  if (!status) return candidates.push({ system: "github", ids, label, refusal: `state ${said(i.state)} with reason ${said(i.state_reason)} isn't in the GitHub mapping` });
  // The synchronization's free-text detail can name whoever has the issue now, so it is never carried:
  // the note is built only from the reason and values this program checks.
  const WHY = {
    closed: () => (i.state === "closed" ? `closed${isTime(i.closed_at) ? ` ${shown(i.closed_at, true)}` : ""}${isText(i.state_reason) && /^[a-z_]{1,20}$/.test(i.state_reason) ? ` (${i.state_reason})` : ""}` : "closed when noticed, since reopened (no longer assigned to me)"),
    unassigned: () => (isText(leaving?.detail) && leaving.detail.trim() === "now assigned to no one" ? "unassigned: now assigned to no one" : "unassigned: now assigned to another account (name not carried)"),
    transferred: () => "moved to another address (details not carried)",
    inaccessible: () => "no longer readable with this token (details not carried)",
    "out of scope": () => "its repository is no longer in scope, or couldn't be read (details not carried)",
  };
  // The synchronization keeps re-reading an item that left and refreshes its state, but not the
  // reason it left: when the state was seen after the item left, the note also says what it is now.
  const refreshed = leaving && isTime(i.state_seen_at) && isTime(leaving.detected_at) && Date.parse(i.state_seen_at) > Date.parse(leaving.detected_at);
  const who = () => {
    const a = Array.isArray(i.assignees) ? i.assignees : [];
    const me = a.some((x) => isText(x) && x === gh.identity?.login), others = a.some((x) => !(isText(x) && x === gh.identity?.login));
    const closedNote = i.state === "closed" ? " on GitHub, but closed, so not in my open work" : " on GitHub, but not returned by the last search for my open work";
    return !a.length ? "assigned to no one" : me && others ? `still assigned to me and another account (name not carried)${closedNote}` : me ? `still assigned to me${closedNote}` : "assigned to another account (name not carried)";
  };
  const now = () => `${i.state === "closed" ? `closed${isTime(i.closed_at) ? ` ${shown(i.closed_at, true)}` : ""}${isText(i.state_reason) && /^[a-z_]{1,20}$/.test(i.state_reason) ? ` (${i.state_reason})` : ""}` : "open"}, ${who()}`;
  const note = leaving && isText(leaving.reason) && Object.hasOwn(WHY, leaving.reason) && isTime(leaving.detected_at)
    ? (refreshed ? `${leaving.reason} when noticed ${shown(leaving.detected_at, true)}; as of ${shown(i.state_seen_at, true)}: ${now()}` : `${WHY[leaving.reason]()}; noticed ${shown(leaving.detected_at, true)}`)
    : undefined;
  const links = Array.isArray(i.links) ? i.links : [];
  candidates.push({
    system: "github", ids, label,
    record: {
      title: i.title, status, blocked: "unknown",
      assigned_to_me: leaving ? "no" : "yes",
      assignment_note: note,
      status_as_of: leaving ? (i.state_seen_at ?? i.last_synced_at) : i.last_synced_at,
      type: undefined, labels: plain(i.labels), created: i.created_at, updated: i.updated_at, closed: i.closed_at ?? (i.state === "closed" ? undefined : null),
      related: links.filter((l) => l?.kind === "issue" && isText(l.repository) && Number.isInteger(l.number)).map((l) => ({ node: l.node_id, address: mine(l.repository) ? `${l.repository}#${l.number}` : "an issue in another account's repository (name not carried)", label: "address when linked" })),
      delivery_evidence: ["exists", "partial", "missing"].includes(i.delivery_evidence) ? i.delivery_evidence : undefined,
      provenance: { source_system: "github", source_id: `${i.repository}#${i.number} (node ID ${i.node_id})`, source_url: isText(i.url) && i.url === `https://github.com/${i.repository}/issues/${i.number}` ? i.url : undefined, retrieved_at: i.last_synced_at, sync_run: ghRun },
      source: { repository: i.repository, number: i.number, node_id: new Code(i.node_id), state: i.state, state_reason: i.state_reason ?? "none given", author: ghMe(i.author), [leaving ? "assignees (last known)" : "assignees"]: Array.isArray(i.assignees) ? i.assignees.map(ghMe) : isText(i.assignees) ? ghMe(i.assignees) : plain(i.assignees), milestone: i.milestone === undefined || i.milestone === null ? "none" : isText(i.milestone) ? i.milestone : isMap(i.milestone) && isText(i.milestone.title) ? i.milestone.title : STRUCT, body: i.body, moved_from: Array.isArray(i.moved_from) ? i.moved_from.map((m) => (isMap(m) && isText(m.repository) && Number.isInteger(m.number) && (m.node_id === undefined || (isText(m.node_id) && NODE_RE.test(m.node_id))) ? `${mine(m.repository) ? `${m.repository}#${m.number}` : "another account's repository (name not carried)"}, ${m.node_id ? `node ID ${m.node_id}` : "same node ID"}, noticed ${shown(m.noticed_at, true)}` : STRUCT)) : [], comments: Array.isArray(i.comments) ? `${i.comments.length} in the synchronized copy (not copied)` : undefined, events: Array.isArray(i.events) ? `${i.events.length} in the synchronized copy (not copied)` : undefined, pull_requests: links.filter((l) => l?.kind === "pull_request" && isText(l.repository) && Number.isInteger(l.number)).map((l) => `${mine(l.repository) ? `${l.repository}#${l.number}` : "a pull request in another account's repository (name not carried)"}${["open", "closed", "merged"].includes(l.state) ? `, ${l.state}` : ""}${l.closes_this_issue ? ", says it closes this issue" : ""}${Array.isArray(l.commits) ? `, ${l.commits.length} commit${l.commits.length === 1 ? "" : "s"}` : ""}`) },
    },
  });
}
for (const [i, leaving] of ghRaw) mapOne("github", i, () => githubItem(i, leaving));

// ---- 3. one run at a time: the lock is taken before the identity file is read -----------------------

for (const d of [modelDir, itemsDir]) {
  if (existsSync(d) && !lstatSync(d).isDirectory()) fail(`${d} isn't an ordinary folder`);
}
mkdirSync(itemsDir, { recursive: true });
let lockFd;
try { lockFd = openSync(join(modelDir, ".normalize.lock"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
catch { fail(`another normalization holds ${join(modelDir, ".normalize.lock")} (remove it only if no run is going)`); }
lockPath = join(modelDir, ".normalize.lock");
writeSync(lockFd, String(process.pid));
closeSync(lockFd);

// ---- 4. identity: the remembered aliases decide, nothing is guessed --------------------------------

const identityPath = join(modelDir, "identity.json");
const known = existsSync(identityPath) ? readJson(identityPath, "identity file") : { model_version: MODEL_VERSION, items: {} };
if (!isMap(known) || !isMap(known.items)) fail("the identity file has no items");
const aliasOf = new Map();
for (const [id, v] of Object.entries(known.items)) {
  if (!safeId(id) || !Array.isArray(v?.aliases) || !v.aliases.every(safeId)) fail(`the identity file's entry ${JSON.stringify(id)} is malformed`);
  for (const a of [id, ...v.aliases]) {
    if (aliasOf.has(a) && aliasOf.get(a) !== id) fail(`the identity file gives ${a} to two items`);
    aliasOf.set(a, id);
  }
}

const records = new Map(); // canonical id -> record
const groups = new Map();  // canonical id -> candidates resolving to it
const groupOfId = new Map();
for (const c of candidates) {
  const found = [...new Set(c.ids.map((x) => aliasOf.get(x)).filter(Boolean))];
  const via = [...new Set(c.ids.map((x) => groupOfId.get(x)).filter(Boolean))];
  const ids = [...new Set([...found, ...via])];
  if (ids.length > 1 && found.length > 1) { refused.push({ label: c.label, reason: `its identifiers belong to two records (${found.join(", ")}); not guessed`, ids: c.ids, disputed: true }); continue; }
  const id = via[0] ?? found[0] ?? c.ids[0];
  if (!safeId(id)) { refused.push({ label: c.label, reason: "its identity isn't usable", ids: c.ids, disputed: true }); continue; }
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(c);
  for (const x of [id, ...c.ids]) groupOfId.set(x, id);
}
for (const [id, cs] of groups) {
  if (cs.length > 1) {
    for (const c of cs) refused.push({ label: c.label, reason: `appears more than once in the synchronized copies (${id}); no copy is used`, ids: [id, ...c.ids], disputed: true });
    continue;
  }
  const c = cs[0];
  if (c.refusal) { refused.push({ label: c.label, reason: c.refusal, ids: [id, ...c.ids], disputed: !!c.disputed }); continue; }
  const before = known.items[id]?.aliases ?? [];
  const aliases = [...new Set([...before, ...c.ids])].filter((x) => x !== id);
  records.set(id, { id, aliases, system: c.system, ...c.record, open: ["todo", "in_progress"].includes(c.record.status) ? "yes" : "no", model_version: MODEL_VERSION, label: c.label });
}
// Two identities whose file names differ only in letter case would share one file on a
// case-insensitive disk: both are refused rather than one overwriting the other.
const byLower = new Map();
for (const id of [...Object.keys(known.items), ...records.keys()]) {
  const k = fileFor(id).toLowerCase();
  if (!byLower.has(k)) byLower.set(k, new Set());
  byLower.get(k).add(id);
}
for (const ids of byLower.values()) {
  if (ids.size < 2) continue;
  for (const id of ids) if (records.has(id)) { const r = records.get(id); refused.push({ label: r.label, reason: `its file name would match another item's except for letter case (${[...ids].join(", ")})`, ids: [id, ...r.aliases] }); records.delete(id); }
}

// Every copy of a disputed identity is refused: any record reached from a disputed entry's
// identifiers (directly, through a remembered alias, or through this run's grouping) is not written.
const tainted = new Set();
for (const x of refused) if (x.disputed) for (const i of x.ids ?? []) { for (const c of [aliasOf.get(i), groupOfId.get(i), i]) if (c) tainted.add(c); }
for (const [id, r] of [...records]) {
  if (tainted.has(id) || r.aliases.some((a) => tainted.has(a))) {
    refused.push({ label: r.label, reason: `shares an identifier with an entry that was refused as disputed (${id}); not guessed`, ids: [id, ...r.aliases], disputed: true });
    records.delete(id);
  }
}

// ---- 5. validation pass: every required field, an allowed value -----------------------------------

const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const jiraHosts = new Map();
const jiraPage = (u) => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && !x.search && !x.hash && x.port === "" && /^\/browse\/[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(x.pathname) ? x.host : ""; } catch { return ""; } };
for (const r of records.values()) if (r.system === "jira" && isText(r.provenance.source_url)) { const h = jiraPage(r.provenance.source_url); if (h) jiraHosts.set(h, (jiraHosts.get(h) ?? 0) + 1); }
// The copy's Jira host is the one most of its stories use; with no clear majority, none is trusted.
const byCount = [...jiraHosts].sort((a, b) => b[1] - a[1]);
const validLinks = byCount.reduce((n, [, c]) => n + c, 0);
const jiraHost = byCount.length && byCount[0][1] * 2 > validLinks ? byCount[0][0] : undefined;

function problems(r) {
  const p = [];
  if (!isText(r.title) || !text(r.title).replace(/\\/g, "").trim()) p.push("title");
  if (!STATUSES.includes(r.status)) p.push("status");
  if (!["yes", "no", "unknown"].includes(r.blocked)) p.push("blocked");
  if (!["yes", "no"].includes(r.assigned_to_me)) p.push("assigned_to_me");
  if (r.assigned_to_me === "no" && !isText(r.assignment_note)) p.push("assignment_note (why it left, and when)");
  if (!isTime(r.status_as_of)) p.push("status_as_of");
  const pv = r.provenance;
  if (!isText(pv.source_id)) p.push("provenance.source_id");
  if (!isText(pv.source_url) || !URL_RE.test(pv.source_url)) p.push("provenance.source_url");
  else if (r.system === "jira" && (!jiraHost || pv.source_url !== `https://${jiraHost}/browse/${pv.source_id}`)) p.push("provenance.source_url (must be the story's own page, on the Jira host the copy's stories use)");
  if (!isTime(pv.retrieved_at)) p.push("provenance.retrieved_at");
  if (!isText(pv.sync_run)) p.push("provenance.sync_run");
  return p;
}
for (const [id, r] of [...records]) {
  const p = problems(r);
  if (p.length) { refused.push({ label: r.label, reason: `required field${p.length > 1 ? "s" : ""} missing or not allowed: ${p.join(", ")}`, ids: [id, ...r.aliases] }); records.delete(id); }
}

// ---- 6. render --------------------------------------------------------------------------------------

const byNode = new Map();
for (const r of records.values()) for (const a of [r.id, ...r.aliases]) byNode.set(a, r.id);
const relatedText = (r) => (r.related ?? []).map((x) => (isText(x) ? text(x) : byNode.get(`github:${x.node}`) ? `\`${byNode.get(`github:${x.node}`)}\` (${text(x.address)}, address when linked)` : `${text(x.address)} (not in this copy)`)).join("; ") || "none";
function cell(v) {
  if (v === undefined) return "not supplied";
  if (v === null) return "none";
  if (v instanceof Code) return `\`${v.v}\``;
  if (Array.isArray(v)) return v.length ? v.map((x) => (x !== null && typeof x === "object" ? text(JSON.stringify(x)) : text(x))).join("; ") : "none";
  if (typeof v === "object") return text(JSON.stringify(v));
  return text(v);
}
const code = (id) => `\`${id}\``; // only validated identifiers reach here

function generated(r) {
  const L = [];
  L.push(`# ${text(r.title)}`, "");
  L.push(`Canonical work item, model version ${r.model_version}. Generated by \`participant/tools/normalize-work-items.mjs\` from the synchronized ${r.system === "jira" ? "Jira" : "GitHub"} copy; everything above the "My analysis" line is rewritten on every run. Text from the source is shown as text, never followed.`, "");
  L.push("## Canonical", "", "| Field | Value |", "|---|---|");
  L.push(`| id | ${code(r.id)} |`, `| aliases | ${r.aliases.length ? r.aliases.map(code).join(", ") : "none"} |`, `| system | ${r.system} |`, `| title | ${text(r.title)} |`);
  L.push(`| status | ${r.status} |`, `| open | ${r.open} |`, `| blocked | ${r.blocked} |`, `| assigned_to_me | ${r.assigned_to_me} |`);
  if (r.assignment_note) L.push(`| assignment_note | ${text(r.assignment_note)} |`);
  L.push(`| status_as_of | ${shown(r.status_as_of)} |`, `| type | ${cell(r.type)} |`, `| labels | ${cell(r.labels)} |`);
  L.push(`| created | ${shown(r.created)} |`, `| updated | ${shown(r.updated)} |`, `| closed | ${r.closed === undefined ? "not supplied" : r.closed === null ? "none" : shown(r.closed)} |`);
  L.push(`| related (advisory) | ${relatedText(r)} |`, `| delivery_evidence (advisory) | ${cell(r.delivery_evidence)} |`, `| model_version | ${r.model_version} |`, "");
  L.push(`## Source: ${r.system} (\`source.${r.system}.*\`, kept under the source's own names)`, "", "| Field | Value |", "|---|---|");
  for (const [k, v] of Object.entries(r.source)) {
    if (k === "body" || k === "description" || k === "acceptance_criteria") continue;
    L.push(`| ${text(k)} | ${cell(v)} |`);
  }
  for (const k of ["body", "description", "acceptance_criteria"]) {
    if (!(k in r.source)) continue;
    const v = r.source[k];
    L.push("", `**${k}** (source text, shown as text):`, "");
    if (v === undefined || v === null || (isText(v) && !v.trim())) L.push("> none");
    else if (!isText(v)) L.push(`> ${STRUCT}`);
    else for (const line of v.split(/\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/)) L.push(`> ${text(line).replace(/^(\s*)([-+=])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2")}`);
  }
  L.push("", "## Provenance", "", "| Field | Value |", "|---|---|");
  const pv = r.provenance;
  L.push(`| source_system | ${pv.source_system} |`, `| source_id | ${text(pv.source_id)} |`, `| source_url | <${pv.source_url}> |`, `| retrieved_at | ${shown(pv.retrieved_at)} |`, `| sync_run | ${text(pv.sync_run)} |`, "");
  L.push("Write your own analysis below the next line. Normalization keeps everything after it, byte for byte.", "");
  const out = L.join("\n") + "\n";
  // No generated line may be, or look like, the analysis line.
  const lines = out.split(/\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/);
  const bad = lines.some((l) => /^\s*#+[\s#]*my\s*analysis\s*$/i.test(l.normalize("NFKC").replace(/\\/g, ""))) || lines.filter((l) => l === "## Canonical").length !== 1;
  return bad ? null : out;
}
for (const [id, r] of [...records]) {
  let g;
  try { g = generated(r); } catch (e) { g = undefined; refused.push({ label: r.label, reason: `its record couldn't be rendered (${oneLine(e.message).slice(0, 80)})`, ids: [id, ...r.aliases] }); records.delete(id); continue; }
  if (g === null) { refused.push({ label: r.label, reason: "its title or source text would look like the analysis line or a section heading", ids: [id, ...r.aliases] }); records.delete(id); }
}

// The person's part of an existing file: everything after the one MARKER line, as raw bytes.
function analysisOf(path) {
  if (!existsSync(path)) return { ok: true, bytes: Buffer.from("\n") };
  const st = lstatSync(path);
  if (!st.isFile()) return { ok: false, why: "its file isn't an ordinary file; not touched" };
  const raw = readFileSync(path);
  const at = [];
  let start = 0;
  while (start <= raw.length) {
    let end = raw.indexOf(0x0a, start);
    if (end === -1) end = raw.length;
    if (raw.subarray(start, end).equals(MARKER_BYTES)) at.push(end);
    start = end + 1;
  }
  if (at.length !== 1) return { ok: false, why: `its file has ${at.length} "My analysis" lines, not one; not touched` };
  const cut = Math.min(at[0] + 1, raw.length);
  return { ok: true, head: raw.subarray(0, at[0] - MARKER_BYTES.length), bytes: raw.subarray(cut), raw };
}

// ---- 7. write (each file whole, then renamed into place) -------------------------------------------

function writeWhole(path, content) {
  const tmp = `${path}.${process.pid}.new`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  writeSync(fd, content);
  closeSync(fd);
  renameSync(tmp, path);
}
const banner = (reason) => `> **Not refreshed:** ${text(reason)}. This record is from an earlier run and may be out of date.\n\n`;

const written = [];
const notRefreshed = [];
const untouched = new Set();
var wroteAnything = false; // var: fail() may read it before this line runs
try {
  for (const r of [...records.values()]) {
    const path = join(itemsDir, fileFor(r.id));
    const a = analysisOf(path);
    if (!a.ok) { refused.push({ label: r.label, reason: a.why, ids: [r.id, ...r.aliases] }); records.delete(r.id); untouched.add(r.id); continue; }
    if (a.raw && existsSync(path) && !readFileSync(path).equals(a.raw)) { refused.push({ label: r.label, reason: "its file changed while the run was working; not touched (run again)", ids: [r.id, ...r.aliases] }); records.delete(r.id); untouched.add(r.id); continue; }
    writeWhole(path, Buffer.concat([Buffer.from(generated(r) + MARKER + "\n"), a.bytes]));
    wroteAnything = true;
    const back = analysisOf(path);
    if (!back.ok || !back.bytes.equals(a.bytes)) throw new Error(`the analysis of ${r.id} didn't read back unchanged`);
    written.push({ r, analysisSha: sha(a.bytes) });
  }
  // Earlier records whose item is refused, or is in neither copy now: kept, marked.
  const refusedIds = new Map();
  for (const x of refused) for (const i of x.ids) if (aliasOf.has(i)) refusedIds.set(aliasOf.get(i), x.reason);
  for (const id of Object.keys(known.items)) {
    if (records.has(id) || untouched.has(id)) continue;
    const path = join(itemsDir, fileFor(id));
    if (!existsSync(path)) continue;
    const reason = refusedIds.get(id) ?? "no longer in either synchronized copy";
    const a = analysisOf(path);
    if (!a.ok) { refused.push({ label: id, reason: `${reason}; ${a.why}`, ids: [id] }); continue; }
    const head = a.head.toString("utf8");
    const lines = head.split("\n");
    const kept = [];
    for (let n = 0; n < lines.length; n++) {
      if (lines[n].startsWith("> **Not refreshed:**")) { if (lines[n + 1] === "") n++; continue; }
      kept.push(lines[n]);
    }
    const at = kept.indexOf("## Canonical");
    if (at === -1) { notRefreshed.push({ id, reason: `${reason}; its file has no Canonical section, so it couldn't be marked` }); continue; }
    const marked = [...kept.slice(0, at), banner(reason).replace(/\n\n$/, ""), "", ...kept.slice(at)].join("\n");
    writeWhole(path, Buffer.concat([Buffer.from(marked + MARKER + "\n"), a.bytes]));
    const back = analysisOf(path);
    if (!back.ok || !back.bytes.equals(a.bytes)) throw new Error(`the analysis of ${id} didn't read back unchanged`);
    wroteAnything = true;
    notRefreshed.push({ id, reason });
  }
  // identity file: every alias ever seen, kept
  const items = { ...known.items };
  for (const r of records.values()) items[r.id] = { aliases: r.aliases, file: `items/${fileFor(r.id)}` };
  const owner = new Map();
  for (const [id, v] of Object.entries(items)) for (const a of [id, ...v.aliases]) owner.set(a, id);
  for (const x of refused) {
    if (x.disputed) continue; // an identifier in dispute is never remembered for anyone
    const ids = (x.ids ?? []).filter(safeId);
    const found = [...new Set(ids.map((a) => owner.get(a)).filter(Boolean))];
    if (found.length !== 1 || !items[found[0]]) continue;
    const add = ids.filter((a) => !owner.has(a));
    if (add.length) { items[found[0]] = { ...items[found[0]], aliases: [...items[found[0]].aliases, ...add] }; add.forEach((a) => owner.set(a, found[0])); }
  }
  writeWhole(identityPath, JSON.stringify({ about: "Canonical identities and every alias seen for each; written by normalize-work-items.mjs. An alias is never given to two items.", model_version: MODEL_VERSION, items }, null, 2) + "\n");
  wroteAnything = true;

  // index
  const all = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  const openMine = all.filter((r) => r.open === "yes" && r.assigned_to_me === "yes");
  const I = ["# Canonical work items", "", `Model version ${MODEL_VERSION}; generated by \`participant/tools/normalize-work-items.mjs\`. Sources: ${text(jiraRun)}; ${text(ghRun)}.`, ""];
  I.push("## My open work, across systems", "", `- Open and assigned to me: ${openMine.length}`, `- Blocked: ${openMine.filter((r) => r.blocked === "yes").length}; not blocked: ${openMine.filter((r) => r.blocked === "no").length}; **can't say: ${openMine.filter((r) => r.blocked === "unknown").length}** (the source doesn't record blocking)`, `- Not counted above: ${notRefreshed.length} record${notRefreshed.length === 1 ? "" : "s"} not refreshed this run, and ${refused.length} item${refused.length === 1 ? "" : "s"} not represented this run (both listed below); any of them may be open work of mine`, "");
  I.push("## Items", "", "| id | system | title | status | open | blocked | assigned to me | status as of | file |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of all) I.push(`| ${code(r.id)} | ${r.system} | ${text(r.title)} | ${r.status} | ${r.open} | ${r.blocked} | ${r.assigned_to_me} | ${shown(r.status_as_of)} | [${fileFor(r.id)}](${fileFor(r.id)}) |`);
  I.push("", "## Not represented", "");
  if (refused.length) { I.push("| Item | Reason |", "|---|---|"); for (const x of refused) I.push(`| ${text(x.label)} | ${text(x.reason)} |`); } else I.push("None.");
  I.push("", "## Not refreshed (earlier records kept, marked)", "");
  if (notRefreshed.length) { I.push("| id | Reason |", "|---|---|"); for (const x of notRefreshed) I.push(`| ${code(x.id)} | ${text(x.reason)} |`); } else I.push("None.");
  writeWhole(join(itemsDir, "index.md"), I.join("\n") + "\n");

  // examples: one item from each system, side by side (open and mine first)
  const pick = (sys) => all.filter((r) => r.system === sys).sort((a, b) => (b.open === "yes") - (a.open === "yes") || (b.assigned_to_me === "yes") - (a.assigned_to_me === "yes"))[0];
  const j = pick("jira"), g = pick("github");
  if (!(j && g)) {
    writeWhole(join(modelDir, "examples.md"), `# Two synchronized items in the canonical model\n\nNot generated this run: the copies hold no ${j ? "GitHub" : "Jira"} item that could be represented, and the examples need one from each system.\n`);
  } else {
    const row = (name, f) => `| ${name} | ${f(j)} | ${f(g)} |`;
    const E = ["# Two synchronized items in the canonical model", "", `Generated by \`participant/tools/normalize-work-items.mjs\` from the two synchronized copies: the Jira quest's synchronization of its practice Jira (${text(jiraRun)}) and the GitHub quest's synchronization of real issues in the signed-in account's public practice repositories (${text(ghRun)}). The Jira item is the Jira quest's practice data (that quest synchronizes only its practice Jira); the GitHub item is a real issue. One item from each system, side by side; the differences are left visible, not smoothed away. Each item's full record is linked. The account name in repository names and links is the owner of those public repositories, kept because provenance needs the address; where it stands for a person it is written "me".`, ""];
    E.push("## Canonical fields", "", `| Field | [${j.id}](items/${fileFor(j.id)}) | [${g.id}](items/${fileFor(g.id)}) |`, "|---|---|---|");
    E.push(row("system", (r) => r.system), row("title", (r) => text(r.title)), row("status", (r) => r.status), row("open", (r) => r.open), row("blocked", (r) => r.blocked), row("assigned_to_me", (r) => r.assigned_to_me), row("status_as_of", (r) => shown(r.status_as_of)));
    E.push(row("aliases", (r) => (r.aliases.length ? r.aliases.map(code).join(", ") : "none")), row("type", (r) => cell(r.type)), row("labels", (r) => cell(r.labels)), row("closed", (r) => (r.closed === undefined ? "not supplied" : r.closed === null ? "none" : shown(r.closed))), row("delivery_evidence (advisory)", (r) => cell(r.delivery_evidence)), row("related (advisory)", (r) => relatedText(r)));
    E.push(row("provenance.source_id", (r) => text(r.provenance.source_id)), row("provenance.source_url", (r) => `<${r.provenance.source_url}>`), row("provenance.retrieved_at", (r) => shown(r.provenance.retrieved_at)), row("provenance.sync_run", (r) => text(r.provenance.sync_run)), "");
    E.push("## Source fields (kept under each source's own names)", "", "| Jira (`source.jira.*`) | GitHub (`source.github.*`) |", "|---|---|");
    const js = Object.entries(j.source).filter(([k]) => !["description", "acceptance_criteria"].includes(k)).map(([k, v]) => `${text(k)}: ${cell(v)}`);
    const gs = Object.entries(g.source).filter(([k]) => k !== "body").map(([k, v]) => `${text(k)}: ${cell(v)}`);
    for (let n = 0; n < Math.max(js.length, gs.length); n++) E.push(`| ${js[n] ?? ""} | ${gs[n] ?? ""} |`);
    E.push("", "## The differences, kept", "");
    const n = g.aliases.length;
    E.push(`- **Identity:** ${code(j.id)} is Jira's key standing in for its numeric issue ID; ${code(g.id)} is a GitHub node ID${n ? `, with ${n} later node ID${n > 1 ? "s" : ""} kept as ${n > 1 ? "aliases" : "an alias"} after ${n > 1 ? "moves" : "a move"}` : ""}.`);
    E.push(`- **Status:** Jira says "${text(j.source.status)}" (\`${j.status}\`); GitHub says ${text(g.source.state)}${g.source.state_reason && g.source.state_reason !== "none given" ? ` (${text(g.source.state_reason)})` : ""} (\`${g.status}\`). GitHub can never say \`in_progress\`.`);
    E.push("- **Blocked:** `unknown` for both: neither copy records blocking, so neither is counted as not blocked.");
    E.push(`- **Closed time:** Jira's copy has none to give ("not supplied"); GitHub's is ${g.closed === null ? '"none" because this issue is open' : g.closed === undefined ? '"not supplied" (closed, but the copy gives no time)' : shown(g.closed)}.`);
    const only = (a, b) => Object.keys(a.source).filter((k) => !(k in b.source) && a.source[k] !== undefined && !["description", "acceptance_criteria", "body"].includes(k)).map(text).join(", ") || "nothing";
    E.push(`- **Source fields only this Jira item has:** ${only(j, g)}. **Only this GitHub item has:** ${only(g, j)}.`);
    E.push("- **Text:** Jira has a description and acceptance criteria; GitHub has one body. Each is shown, as text, in the item's full record.");
    writeWhole(join(modelDir, "examples.md"), E.join("\n") + "\n");
  }
} catch (e) {
  try { unlinkSync(lockPath); } catch {}
  console.error(`Stopped while writing: ${oneLine(e.message)}. ${wroteAnything ? "Some files were written (each one whole); run again to finish." : "Nothing was written."}`);
  process.exit(1);
}
try { unlinkSync(lockPath); } catch {}

// ---- 8. report ----------------------------------------------------------------------------------

console.log(`Normalized ${shown(new Date().toISOString())}, model version ${MODEL_VERSION}. Sources: ${jiraRun}; ${ghRun}.`);
console.log(`Records written: ${written.length} (Jira ${written.filter((w) => w.r.system === "jira").length}, GitHub ${written.filter((w) => w.r.system === "github").length}).`);
for (const w of written) console.log(`  ${w.r.id}  ${w.r.status}${w.r.open === "yes" ? ", open" : ""}, blocked ${w.r.blocked}, assigned to me ${w.r.assigned_to_me}${w.r.aliases.length ? `; aliases ${w.r.aliases.join(", ")}` : ""}; "${oneLine(w.r.title)}"; analysis sha256 ${w.analysisSha.slice(0, 16)}`);
console.log(`Not represented:${refused.length ? "" : " none."}`);
for (const x of refused) console.log(`  ${oneLine(x.label)}: ${oneLine(x.reason)}; no record written for it.`);
console.log(`Not refreshed (earlier records kept, marked):${notRefreshed.length ? "" : " none."}`);
for (const x of notRefreshed) console.log(`  ${x.id}: ${oneLine(x.reason)}`);
process.exit(refused.length || notRefreshed.length ? 2 : 0);
