#!/usr/bin/env node
// Read-only synchronization of the GitHub issues assigned to the signed-in user.
//
// What it does, in order:
//   1. Asks GitHub who the token belongs to (GET /user). No login is written in this file.
//   2. Checks every repository in the scope list; any it can't read is reported, never skipped.
//   3. Searches each readable repository for open issues assigned to that login (is:issue), page
//      by page, until GitHub sends no "next" page, and checks the items received equal GitHub's
//      total.
//   4. Keeps pull requests out: the search asks for issues only, anything still carrying a
//      "pull_request" key is dropped and counted, and a separate is:pull-request search lists the
//      assigned pull requests that were left out.
//   5. Reads each issue directly (fresh fields), its comments and its timeline, and the pull
//      requests and commits it links to.
//   6. Merges with the previous run by node ID (GitHub's permanent ID), keeps each issue's
//      "My notes" section byte for byte, and moves an issue that is no longer assigned to a
//      separate list with the reason and its last known record. Nothing is deleted.
//   7. Writes one Markdown file per issue, index.md, delivery-links.md and sync-state.json,
//      all together, or nothing.
//
// It never writes to GitHub: every request is a GET. The token comes only from the environment
// variable GTQ_GITHUB_TOKEN; it is never printed or written anywhere. Raw responses are never
// saved; only the normalized fields below are.
//
// Exit codes: 0 done; 1 GitHub's answer was incomplete or unexpected (nothing written);
// 2 a local check refused (nothing written).
//
// Usage: node participant/tools/github-sync.mjs [--scope FILE] [--out DIR] [--per-page N]
//        [--api URL]   (URL: https://api.github.com, or http://127.0.0.1:PORT for a practice server)

import {
  closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmdirSync, unlinkSync, writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { constants as FS, fstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// Every message has the token's exact value removed, whatever it quotes (a header, an address,
// an error): the token is never printed.
const clean = (m) => {
  const t = process.env.GTQ_GITHUB_TOKEN ?? "";
  return t ? String(m).split(t).join("[token]") : String(m);
};
const refuse = (message) => {
  console.error(clean(message));
  process.exit(2);
};
const incomplete = (message) => {
  console.error(clean(`Incomplete: ${message}; nothing was written.`));
  process.exit(1);
};

// ---- options ------------------------------------------------------------------------------------
const opts = { scope: join(REPO, "participant/context/github/scope.json"), out: join(REPO, "participant/context/github/assigned"), perPage: 100, api: "https://api.github.com" };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const v = a[i + 1];
    if (a[i] === "--scope" && v) opts.scope = a[++i];
    else if (a[i] === "--out" && v) opts.out = a[++i];
    else if (a[i] === "--per-page" && /^[1-9][0-9]?$|^100$/.test(v ?? "")) { opts.perPage = Number(v); i++; }
    else if (a[i] === "--api" && v) opts.api = a[++i];
    else refuse("Usage: github-sync.mjs [--scope FILE] [--out DIR] [--per-page 1-100] [--api URL]");
  }
}
// Only GitHub itself, or a practice server on this computer.
if (opts.api !== "https://api.github.com" && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(opts.api)) {
  refuse("--api must be https://api.github.com or http://127.0.0.1:PORT; nothing was read.");
}
const TOKEN = process.env.GTQ_GITHUB_TOKEN ?? "";
if (TOKEN === "" || /\s/.test(TOKEN)) {
  refuse("GTQ_GITHUB_TOKEN isn't set (or holds spaces). Load the read-only token into this terminal first; nothing was read.");
}
// A practice server on this computer is never sent a real token: only one starting "pretend-".
if (opts.api !== "https://api.github.com" && !/^pretend-[A-Za-z0-9-]{1,80}$/.test(TOKEN)) {
  refuse("With --api on this computer, GTQ_GITHUB_TOKEN must be a pretend one (pretend-...), never a real token; nothing was read.");
}

const nowDate = new Date();
const now = nowDate.toISOString();
const p2 = (n) => String(n).padStart(2, "0");
// For people: MM-DD-YYYY and a 12-hour time, in this computer's time zone.
const shown = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${d.getFullYear()} ${h}:${p2(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
};

// ---- the scope list -----------------------------------------------------------------------------
// Owner and repository names: letters, digits, "-", "_", "."; never starting with "."; they become
// parts of file names.
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
// GitHub node IDs: letters, digits, "_", "-", "=". They are printed into Markdown, so nothing else.
const NODE = /^[A-Za-z0-9_=-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const FULL = (s) => typeof s === "string" && s.split("/").length === 2 && s.split("/").every((p) => NAME.test(p));
let scope;
try {
  scope = JSON.parse(readFileSync(opts.scope, "utf8"));
} catch {
  refuse(`The scope list (${opts.scope}) can't be read as JSON; nothing was read.`);
}
const repos = scope?.repositories;
if (!Array.isArray(repos) || repos.length === 0 || !repos.every(FULL) || new Set(repos.map((r) => r.toLowerCase())).size !== repos.length) {
  refuse("The scope list must hold \"repositories\": a list of distinct owner/name entries; nothing was read.");
}

// ---- the output folder, checked before GitHub is asked anything --------------------------------
// The same checks run again while holding the lock, just before writing.
const out = resolve(opts.out);
const NOT_ORDINARY = Symbol("not an ordinary file");
// Read a file only after lstat says it is an ordinary file (a link is never followed, and a named
// pipe is never opened), and only if it is valid UTF-8: decoding never replaces bytes, so a notes
// section is kept exactly or the run stops. Gives the text, null if absent, or NOT_ORDINARY.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// The file is opened once, without following a link and without waiting on a pipe, and checked
// through that same opening, so it can't be swapped between the check and the read.
const readOrdinary = (path) => {
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code === "ELOOP" || err.code === "EMLINK" || err.code === "ENXIO" || err.code === "EISDIR") return NOT_ORDINARY;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) return NOT_ORDINARY;
    try { return UTF8.decode(readFileSync(fd)); } catch { return NOT_ORDINARY; }
  } finally {
    closeSync(fd);
  }
};
const rel = relative(REPO, out);
const inRepo = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
const dirs = [];
if (inRepo) {
  let p = REPO;
  for (const part of rel.split(sep).filter(Boolean)) dirs.push((p = join(p, part)));
} else {
  dirs.push(out);
}
const issuesDir = join(out, "issues");
dirs.push(issuesDir);
const shownDir = (d) => (inRepo ? relative(REPO, d) : d);
const checkDirs = (stop) => {
  const missing = [];
  for (const dir of dirs) {
    let st = null;
    try { st = lstatSync(dir); } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (st === null) missing.push(dir);
    else if (st.isSymbolicLink() || !st.isDirectory()) stop(`The folder ${shownDir(dir)} isn't an ordinary folder (it is a link or a file); nothing was written.`);
    else if (missing.length) stop(`${shownDir(dir)} exists inside a missing folder; nothing was written.`);
  }
  return missing;
};
const missingDirs = checkDirs(refuse);
// Outside the repository, the folder named is used as named (macOS's own /tmp is a link), but where
// it really is is recorded now and must be the same under the lock: a parent swapped for a link
// meanwhile stops the run.
const whereReally = () => {
  let d = out;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return join(realpathSync(d), relative(d, out));
};
const outReally = whereReally();
// A run killed while writing (it can't clean up after SIGKILL or a power cut) leaves its staged
// ".<pid>.new" or kept ".<pid>.old" files, and its lock. Until a person has looked, no run starts.
for (const dir of [out, issuesDir]) {
  let names = [];
  try { names = readdirSync(dir); } catch (err) { if (err.code !== "ENOENT") throw err; }
  const left = names.filter((n) => /\.[0-9]+\.(new|old|saved)$/.test(n));
  if (left.length) refuse(`A previous run stopped while writing and left ${left.map((n) => relative(out, join(dir, n))).join(", ")}; nothing was written. Check the folder (a .old file is the previous version), tidy it, then run again.`);
}

// Files this tool writes start with these lines, so a file a person wrote is never replaced.
const RECORD_HEAD = "<!-- github-sync: issue record. Everything above the notes line is rewritten on each run. -->";
const NOTES_LINE = "<!-- github-sync: notes below. The synchronization never changes anything after this line. -->";
const INDEX_HEAD = "<!-- github-sync: index, rewritten on each run. -->";
const LINKS_HEAD = "<!-- github-sync: delivery links, rewritten on each run. -->";
const statePath = join(out, "sync-state.json");
const indexPath = join(out, "index.md");
const linksPath = join(out, "delivery-links.md");

const stateText = readOrdinary(statePath);
if (stateText === NOT_ORDINARY) refuse("sync-state.json isn't an ordinary UTF-8 text file; nothing was written.");
let prev = { issues: {}, no_longer_assigned: {}, repositories: {} };
if (stateText !== null) {
  let p;
  try { p = JSON.parse(stateText); } catch { p = null; }
  const okMap = (m) => m && typeof m === "object" && !Array.isArray(m);
  // Every record must have what later steps rely on: its node ID (the key), repository, number,
  // file name, title, comments, events and links. Anything else is left for a person to look at.
  const okRec = (r, id) => okMap(r) && NODE.test(id) && r.node_id === id && FULL(r.repository)
    && (r.previous_node_ids === undefined || (Array.isArray(r.previous_node_ids) && r.previous_node_ids.every((x) => typeof x === "string" && NODE.test(x)))) && Number.isInteger(r.number) && r.number > 0
    && typeof r.file === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/.test(r.file) && typeof r.title === "string"
    && Array.isArray(r.comments) && r.comments.every((c) => okMap(c) && Number.isInteger(c.id) && typeof c.created_at === "string")
    && Array.isArray(r.events) && r.events.every((e) => okMap(e) && typeof e.key === "string") && Array.isArray(r.links);
  const okGone = (g, id) => okMap(g) && g.node_id === id && FULL(g.repository) && Number.isInteger(g.number) && okRec(g.last_known_record, id);
  if (!p || p.tool !== "github-sync" || !okMap(p.issues) || !okMap(p.no_longer_assigned) || !okMap(p.repositories)
    || Object.keys(p.issues).some((k) => k in p.no_longer_assigned)
    || !Object.entries(p.issues).every(([id, r]) => okRec(r, id))
    || !Object.entries(p.no_longer_assigned).every(([id, g]) => okGone(g, id))) {
    refuse("The previous sync-state.json isn't one this tool wrote; nothing was written. Fix or move it, then run again.");
  }
  prev = p;
}
const rootAtStart = new Map();
for (const [path, head, name] of [[indexPath, INDEX_HEAD, "index.md"], [linksPath, LINKS_HEAD, "delivery-links.md"]]) {
  const t = readOrdinary(path);
  rootAtStart.set(path, t);
  if (t === NOT_ORDINARY) refuse(`${name} isn't an ordinary UTF-8 text file; nothing was written.`);
  if (t !== null && !t.startsWith(`${head}\n`)) refuse(`${name} wasn't written by this tool; nothing was written. Move it, then run again.`);
}
// Every issue file this tool knows about: read now, kept as read, and checked again under the
// lock, so a note typed meanwhile is never lost.
const fileBaseline = new Map();
const splitRecord = (text, name) => {
  if (!text.startsWith(`${RECORD_HEAD}\n`)) return { error: `${name} wasn't written by this tool` };
  const lines = text.split("\n");
  const at = lines.indexOf(NOTES_LINE);
  if (at < 0) return { error: `${name} has lost its notes line` };
  if (lines.indexOf(NOTES_LINE, at + 1) >= 0) return { error: `${name} has its notes line twice` };
  return { notes: lines.slice(at + 1).join("\n") };
};
const knownFiles = new Set([...Object.values(prev.issues), ...Object.values(prev.no_longer_assigned).map((r) => r.last_known_record ?? {})]
  .map((r) => r.file).filter((f) => typeof f === "string"));
for (const f of knownFiles) {
  const t = readOrdinary(join(issuesDir, f));
  if (t === NOT_ORDINARY) refuse(`issues/${f} isn't an ordinary UTF-8 text file; nothing was written.`);
  if (t !== null) {
    const s = splitRecord(t, `issues/${f}`);
    if (s.error) refuse(`${s.error}; nothing was written. Restore it, then run again.`);
  }
  fileBaseline.set(f, t);
}

// ---- asking GitHub ------------------------------------------------------------------------------
// Every request is a GET, with the token in a header. A redirect is followed only to the same
// server. Raw bodies stay in memory.
let requests = 0;
const get = async (url, { list = false } = {}) => {
  let u;
  try { u = new URL(url, opts.api); } catch { incomplete("GitHub sent an address that can't be read"); }
  if (u.origin !== new URL(opts.api).origin) incomplete(`GitHub pointed outside ${opts.api} (${u.origin})`);
  // Redirects are followed by hand, at most 3, and each address is checked before it is asked:
  // the token is only ever sent to the one server.
  let res;
  let at = u;
  for (let hop = 0; ; hop++) {
    requests++;
    try {
      res = await fetch(at, {
        method: "GET",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "gtq-github-sync",
        },
      });
    } catch (err) {
      incomplete(`GitHub couldn't be reached (${err.cause?.code ?? err.message})`);
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    // A page of a list is asked for exactly; a redirect could swap in another list or page.
    if (list) incomplete(`GitHub redirected a list request (${at.pathname})`);
    const loc = res.headers.get("location");
    await res.body?.cancel();
    if (!loc || hop >= 3) incomplete(`GitHub redirected ${loc ? "too many times" : "without an address"} (${at.pathname})`);
    try { at = new URL(loc, at); } catch { incomplete(`GitHub redirected to an address that can't be read (${at.pathname})`); }
    if (at.origin !== u.origin) incomplete(`GitHub redirected to another server (${at.origin})`);
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    incomplete("GitHub's rate limit was reached; run again later");
  }
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = undefined; }
  return { status: res.status, headers: res.headers, body, url: at.href, redirected: at.href !== u.href, finalPath: at.pathname };
};
// The "next" page, from GitHub's Link header; null when there is none. Each entry is <address>
// and parameters in any order; rel may be quoted or not and hold several relations. An entry that
// can't be read stops the run rather than look like the end of the list.
const linkRel = (headers, want) => {
  const link = (headers.get("link") ?? "").trim();
  if (link === "") return null;
  let found = null;
  for (const entry of link.match(/<[^>]*>[^,]*/g) ?? []) {
    const m = entry.match(/^<([^>]+)>((?:\s*;\s*[A-Za-z*-]+\s*=\s*(?:"[^"]*"|[^;,\s]+))*)\s*$/);
    if (!m) incomplete(`GitHub sent a Link header that can't be read`);
    const rel = [...m[2].matchAll(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/gi)].map((x) => (x[1] ?? x[2]).toLowerCase().split(/\s+/)).flat().filter(Boolean);
    if (rel.length === 0) incomplete("GitHub sent a Link entry without a relation");
    if (rel.includes(want)) {
      if (found) incomplete(`GitHub's Link header names two ${want} pages`);
      found = m[1];
    }
  }
  if (link.replace(/<[^>]*>[^,]*/g, "").replace(/[\s,]/g, "") !== "" || !/<[^>]*>/.test(link)) incomplete(`GitHub sent a Link header that can't be read`);
  return found;
};
const nextLink = (headers) => linkRel(headers, "next");
// The page number a "last" link names, or null.
const lastPage = (headers) => {
  const l = linkRel(headers, "last");
  if (!l) return null;
  let n = null;
  try { n = Number(new URL(l, opts.api).searchParams.get("page")); } catch { /* checked below */ }
  if (!posInt(n)) incomplete("GitHub's last page link has no page number");
  return n;
};
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
// GitHub's own reason for a refusal, shortened and made printable (it never holds the token).
const said = (r) => {
  const m = isObj(r.body) && typeof r.body.message === "string" ? r.body.message : "";
  const errs = isObj(r.body) && Array.isArray(r.body.errors) ? r.body.errors.map((e) => (isObj(e) ? e.message ?? e.code : e)).filter((x) => typeof x === "string") : [];
  const all = [m, ...errs].filter(Boolean).join(" / ").split(TOKEN).join("[token]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  return all ? ` (GitHub said: "${all}")` : "";
};
const isStr = (x) => typeof x === "string";
// GitHub's times are ISO 8601 in UTC ("2026-11-23T14:26:10Z"); nothing else is accepted.
const isTime = (x) => isStr(x) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(x) && !Number.isNaN(Date.parse(x));
const posInt = (x) => Number.isInteger(x) && x > 0;
// A "next" link must ask for the same list (same path, or GitHub's /repositories/<id>/... form of
// it, and the same query) and for exactly the following page; anything else would let another
// list's items, or a skipped page, pass as this one.
const repoIds = new Map(); // "owner/name" lower-cased -> GitHub's numeric repository id
const sameList = (first, next, page) => {
  const a = new URL(first, opts.api);
  let b;
  try { b = new URL(next, opts.api); } catch { incomplete(`GitHub's next page for ${a.pathname} has an address that can't be read`); }
  if (b.origin !== a.origin) incomplete(`GitHub pointed outside ${opts.api} (${b.origin})`);
  const m = a.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)$/);
  const alt = m && repoIds.has(m[1].toLowerCase()) ? `/repositories/${repoIds.get(m[1].toLowerCase())}${m[2]}` : null;
  const qa = [...a.searchParams].filter(([k]) => k !== "page").map(String).sort().join("&");
  const qb = [...b.searchParams].filter(([k]) => k !== "page").map(String).sort().join("&");
  if ((b.pathname !== a.pathname && b.pathname !== alt) || qa !== qb || b.searchParams.get("page") !== String(page)) {
    incomplete(`GitHub's next page for ${a.pathname} doesn't ask for page ${page} of the same list`);
  }
};
// A list endpoint (comments, timeline, commits): every page until no "next", at most 100 pages.
// A page without a "next" link is the end only if no "last" link names a later page, and a last
// page that is full is checked by asking for the page after it, which must be empty: a dropped
// "next" link can't cut a list (a timeline has no count to compare with) short unnoticed.
const allPages = async (path, what) => {
  const items = [];
  const per = Number(new URL(path, opts.api).searchParams.get("per_page") ?? 30);
  let url = path;
  for (let page = 1; url; page++) {
    if (page > 100) incomplete(`${what} has more than 100 pages`);
    const r = await get(url, { list: true });
    if (r.status !== 200 || !Array.isArray(r.body)) incomplete(`${what}: GitHub answered ${r.status}${said(r)}`);
    const next = nextLink(r.headers);
    const last = lastPage(r.headers);
    if (next && r.body.length === 0) incomplete(`${what}: an empty page that isn't the last`);
    if (next) sameList(path, next, page + 1);
    if (!next && last !== null && last > page) incomplete(`${what}: page ${page} has no next link, but GitHub says the last page is ${last}`);
    items.push(...r.body);
    if (!next && r.body.length >= per) {
      const probe = new URL(path, opts.api);
      probe.searchParams.set("page", String(page + 1));
      const r2 = await get(`${probe.pathname}${probe.search}`, { list: true });
      if (r2.status !== 200 || !Array.isArray(r2.body) || r2.body.length !== 0) incomplete(`${what}: page ${page} was full and had no next link, but page ${page + 1} isn't empty`);
    }
    url = next;
  }
  return items;
};

// 1. Who is signed in.
const who = await get("/user");
if (who.status === 401) refuse("GitHub refused the token (401). Check GTQ_GITHUB_TOKEN; nothing was read.");
if (who.status !== 200 || !isObj(who.body) || !isStr(who.body.login) || !/^[A-Za-z0-9-]{1,39}$/.test(who.body.login) || !posInt(who.body.id)) {
  incomplete("GitHub didn't say who the token belongs to");
}
// A classic token lists its scopes: only read scopes ("read:...") are accepted, and anything else
// (repo, gist, user, workflow...) is refused, so this tool can't be run with more power than it
// needs. A fine-grained token lists none; its read-only setting is checked separately
// (github-sync-record.sh token-check).
const scopes = (who.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const notRead = scopes.filter((sc) => !/^read:[a-z_:]+$/.test(sc));
if (notRead.length) {
  refuse(`This token can do more than read (${notRead.join(", ")}). Use a read-only token; nothing was read.`);
}
const me = { login: who.body.login, id: who.body.id };
// A folder holds one account's copy: another account's token is refused (a login rename is fine,
// the numeric id is what counts).
if (stateText !== null && prev.identity?.id !== me.id) {
  refuse(`This folder holds the copy of another GitHub account (id ${prev.identity?.id ?? "unknown"}), not ${me.login}'s; nothing was written. Use a separate output folder.`);
}
// Described without a "token: value" shape, which secret scanners rightly read as a credential.
const tokenKind = who.headers.get("x-oauth-scopes") === null ? "a fine-grained token, no scopes listed" : `a classic token with the scopes ${scopes.join(", ") || "none"}`;

// 2. Each repository in scope: readable or not, and why.
const repoInfo = {};
for (const full of repos) {
  const r = await get(`/repos/${full}`);
  if (r.status === 200 && isObj(r.body) && FULL(r.body.full_name) && isStr(r.body.node_id) && posInt(r.body.id)) {
    repoInfo[full] = { readable: true, full_name: r.body.full_name, node_id: r.body.node_id, private: r.body.private === true };
    repoIds.set(r.body.full_name.toLowerCase(), r.body.id);
    if (r.body.full_name.toLowerCase() !== full.toLowerCase()) repoInfo[full].note = `GitHub now calls it ${r.body.full_name}`;
  } else if (r.status === 404 || r.status === 403 || r.status === 451) {
    repoInfo[full] = { readable: false, reason: r.status === 404 ? "not found, or this token can't see it (404)" : `refused (${r.status})` };
  } else {
    incomplete(`GitHub answered ${r.status} for the repository ${full}${said(r)}`);
  }
}
const readable = repos.filter((f) => repoInfo[f].readable);
// A repository is known by the name in the scope list and by GitHub's current name (after a rename).
const byLowerName = new Map(readable.flatMap((f) => [[f.toLowerCase(), f], [repoInfo[f].full_name.toLowerCase(), f]]));
const canonName = (name) => (byLowerName.has(name.toLowerCase()) ? repoInfo[byLowerName.get(name.toLowerCase())].full_name : name);

// 3 and 4. Search each readable repository, every page. GitHub's search covers issues and pull
// requests, and today refuses a query that doesn't say which ("Query must include 'is:issue' or
// 'is:pull-request'"), so issues are asked for with is:issue. Pull requests are still told apart
// two ways: any item carrying a "pull_request" key is dropped and counted (a safety net), and a
// separate is:pull-request search lists the pull requests assigned to the same login, so the
// record shows them being left out rather than never seen.
const searchAll = async (q, name, what) => {
  const first = `/search/issues?q=${encodeURIComponent(q)}&per_page=${opts.perPage}`;
  let url = first;
  let declared = null;
  const items = [];
  let pages = 0;
  while (url) {
    pages++;
    if (pages > Math.ceil(1000 / opts.perPage)) incomplete(`the ${what} search for ${name} goes past 1,000 results, where GitHub's search stops`);
    const r = await get(url, { list: true });
    if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.items) || !Number.isInteger(r.body.total_count)) {
      incomplete(`the ${what} search for ${name}: GitHub answered ${r.status}${said(r)}`);
    }
    if (r.body.incomplete_results !== false) incomplete(`GitHub said its ${what} search for ${name} was incomplete`);
    if (declared === null) declared = r.body.total_count;
    else if (r.body.total_count !== declared) incomplete(`the ${what} search for ${name} changed its total from ${declared} to ${r.body.total_count} between pages`);
    if (declared > 1000) incomplete(`${name} has more than 1,000 ${what} matches, more than GitHub's search returns`);
    const next = nextLink(r.headers);
    if (next && r.body.items.length === 0) incomplete(`the ${what} search for ${name}: an empty page that isn't the last`);
    if (next) sameList(first, next, pages + 1);
    items.push(...r.body.items);
    url = next;
  }
  if (items.length !== declared) incomplete(`the ${what} search for ${name} declared ${declared} but sent ${items.length} (GitHub's search may still be catching up with a recent change; run again in a minute)`);
  for (const i of items) {
    if (!isObj(i) || !posInt(i.number) || !isStr(i.node_id) || !NODE.test(i.node_id) || !isStr(i.repository_url)) incomplete(`the ${what} search for ${name} sent an item without a number or node ID`);
    if (!i.repository_url.toLowerCase().endsWith(`/repos/${name.toLowerCase()}`)) incomplete(`the ${what} search for ${name} sent an item from another repository`);
  }
  const ids = items.map((i) => i.node_id);
  if (new Set(ids).size !== ids.length) incomplete(`the ${what} search for ${name} sent the same item twice`);
  return { pages, declared, items };
};
const searchReport = {};
const found = []; // [scope entry, number, node_id]
for (const full of readable) {
  const name = repoInfo[full].full_name;
  const iss = await searchAll(`assignee:${me.login} is:issue is:open repo:${name}`, name, "issue");
  const prs = await searchAll(`assignee:${me.login} is:pull-request is:open repo:${name}`, name, "pull request");
  if (prs.items.some((i) => i.pull_request === undefined)) incomplete(`the pull request search for ${name} returned something that isn't a pull request`);
  // The search index can miss a newly assigned issue in both its items and its total, so the
  // search is checked against GitHub's own list of the repository's open issues assigned to the
  // same login (which also holds pull requests, told apart by their pull_request key).
  const rows = await allPages(`/repos/${name}/issues?assignee=${encodeURIComponent(me.login)}&state=open&per_page=100`, `${name}'s issue list`);
  if (!rows.every((i) => isObj(i) && posInt(i.number) && isStr(i.node_id) && NODE.test(i.node_id))) incomplete(`${name}'s issue list has an item without a number or node ID`);
  if (new Set(rows.map((i) => i.node_id)).size !== rows.length) incomplete(`${name}'s issue list has an item twice`);
  const listed = rows.filter((i) => i.pull_request === undefined);
  const listedPrs = new Set(rows.filter((i) => i.pull_request !== undefined).map((i) => i.node_id));
  const searchedPrs = new Set(prs.items.map((i) => i.node_id));
  if (listedPrs.size !== searchedPrs.size || [...listedPrs].some((x) => !searchedPrs.has(x))) {
    incomplete(`the pull request search and GitHub's issue list for ${name} disagree; GitHub's search may be catching up, run again in a minute`);
  }
  const inSearch = new Set(iss.items.filter((i) => i.pull_request === undefined).map((i) => i.node_id));
  const inList = new Set(listed.map((i) => i.node_id));
  const onlyList = listed.filter((i) => !inSearch.has(i.node_id)).map((i) => `#${i.number}`);
  const onlySearch = iss.items.filter((i) => i.pull_request === undefined && !inList.has(i.node_id)).map((i) => `#${i.number}`);
  if (onlyList.length || onlySearch.length) {
    incomplete(`the search and GitHub's issue list for ${name} disagree (only in the list: ${onlyList.join(", ") || "none"}; only in the search: ${onlySearch.join(", ") || "none"}); GitHub's search may be catching up, run again in a minute`);
  }
  const leaked = [];
  let issues = 0;
  for (const i of iss.items) {
    if (i.pull_request !== undefined) { leaked.push(i.number); continue; }
    issues++;
    found.push([full, i.number, i.node_id]);
  }
  searchReport[full] = {
    pages: iss.pages,
    declared: iss.declared,
    received: iss.items.length,
    pull_requests_in_issue_search: leaked,
    issues,
    pull_requests_assigned: prs.items.map((i) => i.number).sort((a, b) => a - b),
    pull_request_pages: prs.pages,
    checked_against_issue_list: listed.length,
  };
}

// 5. Each issue read directly, with its comments, timeline and links.
const MATERIAL = new Set(["assigned", "unassigned", "labeled", "unlabeled", "milestoned", "demilestoned", "renamed", "closed", "reopened",
  "cross-referenced", "referenced", "connected", "disconnected", "transferred", "locked", "unlocked", "marked_as_duplicate", "unmarked_as_duplicate"]);
const userOf = (u) => (isObj(u) && isStr(u.login) ? u.login : null);
const repoFromApiUrl = (u) => {
  const m = isStr(u) ? u.match(/\/repos\/([^/]+\/[^/]+)$/) : null;
  return m && FULL(m[1]) ? m[1] : null;
};
const readIssue = async (full, number) => {
  const r = await get(`/repos/${repoInfo[full]?.full_name ?? full}/issues/${number}`);
  return r;
};
// Everything later steps rely on must be there and of the right kind; a malformed answer stops
// the run rather than, say, an assignee without an id making an issue look unassigned.
const checkIssueBody = (b, what) => {
  const ok = isObj(b) && posInt(b.number) && isStr(b.node_id) && NODE.test(b.node_id) && isStr(b.title)
    && (b.state === "open" || b.state === "closed") && (b.state_reason == null || isStr(b.state_reason))
    && "body" in b && (b.body === null || isStr(b.body)) && isTime(b.created_at) && isTime(b.updated_at) && (b.closed_at == null || isTime(b.closed_at))
    && Array.isArray(b.assignees) && b.assignees.every((a) => isObj(a) && posInt(a.id) && isStr(a.login))
    && Array.isArray(b.labels) && b.labels.every((l) => isStr(l) || (isObj(l) && isStr(l.name)))
    && (b.milestone == null || (isObj(b.milestone) && isStr(b.milestone.title))) && "user" in b && (b.user === null || userOf(b.user) !== null)
    && Number.isInteger(b.comments) && b.comments >= 0 && repoFromApiUrl(b.repository_url) !== null;
  if (!ok) incomplete(`${what}: GitHub's answer is missing fields or has odd ones`);
};
// References written in text: "owner/repo#12" or "#12" (this repository).
const textRefs = (text, here) => {
  const refs = [];
  if (!isStr(text)) return refs;
  // Full addresses: https://github.com/owner/repo/issues/12, .../pull/12, .../commit/<sha>.
  for (const m of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull|commit)\/([0-9a-f]{40}|[1-9][0-9]{0,8})\b/g)) {
    if (!FULL(m[1])) continue;
    if (m[2] === "commit") { if (SHA.test(m[3])) refs.push({ repository: m[1], sha: m[3] }); }
    else if (/^[1-9][0-9]*$/.test(m[3])) refs.push({ repository: m[1], number: Number(m[3]) });
  }
  for (const m of text.matchAll(/(?<![\w/#])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]{0,8})\b/g)) {
    const repo = m[1] && FULL(m[1]) ? m[1] : m[1] ? null : here;
    if (repo) refs.push({ repository: repo, number: Number(m[2]) });
  }
  return refs;
};
// A closing keyword and the issue: "#12", "owner/repo#12" or the issue's full address.
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#)([1-9][0-9]*)\b/gi;
const closesIssue = (prBody, prRepo, repo, number) => {
  if (!isStr(prBody)) return false;
  for (const m of prBody.matchAll(CLOSES)) {
    const target = (m[1] ?? m[2] ?? prRepo).toLowerCase();
    if (target === repo.toLowerCase() && Number(m[3]) === number) return true;
  }
  return false;
};
const prCache = new Map();
const readPull = async (repo, number, nodeId) => {
  const key = `${repo}#${number}#${nodeId ?? ""}`.toLowerCase();
  if (prCache.has(key)) return prCache.get(key);
  let info;
  const r = await get(`/repos/${repo}/pulls/${number}`);
  const okPull = (b) => isObj(b) && b.number === number && (nodeId == null || b.node_id === nodeId)
    && isStr(b.base?.repo?.full_name) && b.base.repo.full_name.toLowerCase() === canonName(repo).toLowerCase()
    && (b.state === "open" || b.state === "closed") && Number.isInteger(b.commits) && b.commits >= 0
    && typeof b.merged === "boolean" && typeof b.draft === "boolean" && "body" in b && (b.body === null || isStr(b.body)) && (b.merged_at == null || isTime(b.merged_at))
    && b.merged === (b.merged_at != null);
  if (r.status === 200 && okPull(r.body)) {
    const commits = await allPages(`/repos/${repo}/pulls/${number}/commits?per_page=100`, `${repo}#${number} commits`);
    if (!commits.every((c) => isObj(c) && isStr(c.sha) && SHA.test(c.sha))) incomplete(`${repo}#${number}: a commit without a proper SHA`);
    if (new Set(commits.map((c) => c.sha)).size !== commits.length) incomplete(`${repo}#${number}: the same commit twice`);
    if (commits.length !== r.body.commits) incomplete(`${repo}#${number}: GitHub counted ${r.body.commits} commits but sent ${commits.length}`);
    info = {
      readable: true,
      state: r.body.state,
      merged: r.body.merged === true,
      merged_at: r.body.merged_at ?? null,
      draft: r.body.draft === true,
      body: r.body.body ?? "",
      commits: commits.map((c) => ({ sha: c.sha, message: String(c.commit?.message ?? "").split("\n")[0] })),
    };
  } else if ([403, 404, 410].includes(r.status)) {
    info = { readable: false, reason: `GitHub answered ${r.status}` };
  } else {
    incomplete(`the pull request ${repo}#${number}: GitHub answered ${r.status}${r.status === 200 ? " with odd fields" : ""}${said(r)}`);
  }
  prCache.set(key, info);
  return info;
};

// A reference written in text ("#4", "owner/repo#4") may be an issue or a pull request: in a
// readable repository in scope it is looked up once, so a pull request mentioned only in text
// still gets its state and commits.
const refCache = new Map();
const resolveRef = async (repo, number) => {
  const key = `${repo}#${number}`.toLowerCase();
  if (refCache.has(key)) return refCache.get(key);
  let info = null;
  const r = await get(`/repos/${repo}/issues/${number}`);
  if (r.status === 200) {
    checkIssueBody(r.body, `the reference ${repo}#${number}`);
    info = { kind: r.body.pull_request !== undefined ? "pull_request" : "issue", node_id: r.body.node_id, repository: repoFromApiUrl(r.body.repository_url), number: r.body.number };
  } else if (![403, 404, 410].includes(r.status)) {
    incomplete(`looking up the reference ${repo}#${number}: GitHub answered ${r.status}${said(r)}`);
  }
  refCache.set(key, info);
  return info;
};

const current = new Map(); // node_id -> record
let searchBehind = [];
for (const [full, number, nodeId] of found) {
  const name = repoInfo[full].full_name;
  const what = `${name}#${number}`;
  const r = await readIssue(full, number);
  if (r.status !== 200) incomplete(`${what}: GitHub answered ${r.status}${said(r)}`);
  const b = r.body;
  checkIssueBody(b, what);
  if (b.node_id !== nodeId) incomplete(`${what}: the direct read has a different node ID than the search`);
  if (b.number !== number || repoFromApiUrl(b.repository_url).toLowerCase() !== name.toLowerCase()) incomplete(`${what}: the direct read answered for a different address`);
  if (b.pull_request !== undefined) incomplete(`${what}: the search said issue, the direct read says pull request`);
  // The search index can lag behind: the direct read decides. An issue closed or unassigned since
  // the index was updated is left out here (and reported below, if it was assigned last time).
  if (b.state !== "open" || !b.assignees.some((a) => a?.id === me.id)) { searchBehind.push(what); continue; }
  const comments = await allPages(`/repos/${name}/issues/${number}/comments?per_page=100`, `${what} comments`);
  if (comments.length !== b.comments) incomplete(`${what}: GitHub counted ${b.comments} comments but sent ${comments.length}`);
  const cIds = new Set();
  const cleanComments = [];
  for (const c of comments) {
    if (!isObj(c) || !posInt(c.id) || !isStr(c.body) || !isTime(c.created_at) || !isTime(c.updated_at) || !userOf(c.user)) incomplete(`${what}: a comment without an id, author, times or text`);
    // The same comment twice in one answer means the pages overlapped: the count can't be trusted.
    if (cIds.has(c.id)) incomplete(`${what}: GitHub sent comment ${c.id} twice`);
    cIds.add(c.id);
    cleanComments.push({ id: c.id, author: userOf(c.user), created_at: c.created_at, updated_at: c.updated_at, body: c.body });
  }
  const timeline = await allPages(`/repos/${name}/issues/${number}/timeline?per_page=100`, `${what} timeline`);
  const events = [];
  const links = [];
  const eventKeys = new Set();
  for (const e of timeline) {
    if (!isObj(e) || !isStr(e.event)) incomplete(`${what}: a timeline entry without an event name`);
    if (!MATERIAL.has(e.event)) continue;
    // A material event needs a time, and an id unless it is a cross-reference (which GitHub gives
    // no id, and which is then known by its time and its source).
    if (!isTime(e.created_at)) incomplete(`${what}: a ${e.event} event without a time`);
    if (e.id == null && !(e.event === "cross-referenced" && isObj(e.source?.issue))) incomplete(`${what}: a ${e.event} event without an id`);
    if (e.id != null && !posInt(e.id)) incomplete(`${what}: a ${e.event} event with an odd id`);
    if (e.commit_id != null && !(isStr(e.commit_id) && SHA.test(e.commit_id))) incomplete(`${what}: a ${e.event} event with an odd commit`);
    const at = e.created_at;
    const ev = { event: e.event, actor: userOf(e.actor) ?? userOf(e.user), at };
    // What each kind of event must carry; an event without it is a malformed answer.
    const needs = {
      labeled: () => isStr(e.label?.name), unlabeled: () => isStr(e.label?.name),
      milestoned: () => isStr(e.milestone?.title), demilestoned: () => isStr(e.milestone?.title),
      renamed: () => isStr(e.rename?.from) && isStr(e.rename?.to),
      assigned: () => userOf(e.assignee) !== null, unassigned: () => userOf(e.assignee) !== null,
      "cross-referenced": () => isObj(e.source?.issue),
    }[e.event];
    if (needs && !needs()) incomplete(`${what}: a ${e.event} event without what it is about`);
    if (userOf(e.actor) === null && userOf(e.user) === null && e.actor !== null) incomplete(`${what}: a ${e.event} event with an odd actor`);
    if (e.label) ev.label = e.label.name;
    if (e.milestone) ev.milestone = e.milestone.title;
    if (e.rename) ev.rename = { from: e.rename.from, to: e.rename.to };
    if (e.assignee) ev.assignee = userOf(e.assignee);
    if (e.state_reason) ev.state_reason = e.state_reason;
    if (isStr(e.commit_id)) ev.commit = e.commit_id;
    const src = e.source?.issue;
    if (src !== undefined) {
      const srcRepo = src?.repository?.full_name ?? repoFromApiUrl(src?.repository_url);
      if (!isObj(src) || !posInt(src.number) || !isStr(src.node_id) || !NODE.test(src.node_id) || !FULL(srcRepo)) incomplete(`${what}: a ${e.event} event with an odd source`);
      ev.source = { repository: srcRepo, number: src.number, node_id: src.node_id, pull_request: src.pull_request !== undefined };
    }
    // Most events have an id; cross-references don't, so they are known by what and when.
    ev.key = e.id != null ? `id:${e.id}` : `${e.event}:${at}:${ev.source.node_id}`;
    if (eventKeys.has(ev.key)) incomplete(`${what}: GitHub sent one timeline event twice`);
    eventKeys.add(ev.key);
    events.push(ev);
    if (ev.source) links.push({ kind: ev.source.pull_request ? "pull_request" : "issue", repository: ev.source.repository, number: ev.source.number, node_id: ev.source.node_id, via: "cross-reference" });
    if (ev.commit) links.push({ kind: "commit", sha: ev.commit, repository: e.commit_url ? repoFromApiUrl(String(e.commit_url).replace(/\/commits\/[0-9a-f]+$/, "")) : null, via: "commit reference" });
  }
  // References written in the body or comments that GitHub didn't record as links.
  for (const t of [b.body, ...cleanComments.map((c) => c.body)]) {
    for (const ref of textRefs(t, name)) {
      if (ref.sha) { links.push({ kind: "commit", sha: ref.sha, repository: ref.repository, via: "written in the text" }); continue; }
      if (ref.repository.toLowerCase() === name.toLowerCase() && ref.number === number) continue;
      links.push({ kind: "mentioned", repository: ref.repository, number: ref.number, via: "written in the text" });
    }
  }
  // One entry per thing linked: a pull request or issue by repository and number, a commit by sha.
  const linkKey = (l) => (l.kind === "commit" ? `commit:${String(l.repository).toLowerCase()}:${l.sha}` : `${String(l.repository).toLowerCase()}#${l.number}`);
  const byKey = new Map();
  for (const l of links) {
    const k = linkKey(l);
    const had = byKey.get(k);
    if (!had || (had.kind === "mentioned" && l.kind !== "mentioned")) byKey.set(k, { ...l, via: had ? `${l.via}; ${had.via}` : l.via });
  }
  for (const [k, l] of [...byKey]) {
    if (l.kind !== "mentioned" || !byLowerName.has(l.repository.toLowerCase())) continue;
    const ref = await resolveRef(l.repository, l.number);
    if (!ref) { l.state = "not found"; continue; }
    const k2 = `${ref.repository.toLowerCase()}#${ref.number}`;
    byKey.delete(k);
    const had = byKey.get(k2);
    if (had) { had.via = `${had.via}; written in the text`; continue; }
    byKey.set(k2, { kind: ref.kind, repository: ref.repository, number: ref.number, node_id: ref.node_id, via: "written in the text" });
  }
  // Pull requests linked from a readable repository in scope: their state and commits.
  const delivery = [];
  for (const l of byKey.values()) {
    if (l.kind !== "pull_request" || !l.repository || !byLowerName.has(l.repository.toLowerCase())) continue;
    const pr = await readPull(canonName(l.repository), l.number, l.node_id);
    if (!pr.readable) { l.state = "unreadable"; continue; }
    l.state = pr.merged ? "merged" : pr.state;
    l.closes_this_issue = closesIssue(pr.body, l.repository, name, number);
    l.commits = pr.commits;
    delivery.push(l);
  }
  // A commit counts only once GitHub confirms it exists in a readable repository in scope.
  for (const l of byKey.values()) {
    if (l.kind !== "commit") continue;
    if (!l.repository || !byLowerName.has(l.repository.toLowerCase())) { l.state = "not checked (outside the scope)"; continue; }
    const c = await get(`/repos/${canonName(l.repository)}/commits/${l.sha}`);
    if (c.status === 200 && isObj(c.body) && c.body.sha === l.sha) l.state = "confirmed";
    else if ([404, 409, 422].includes(c.status)) l.state = "not found";
    else incomplete(`checking the commit ${l.sha.slice(0, 12)}: GitHub answered ${c.status}${said(c)}`);
  }
  const evidence = delivery.some((l) => l.state === "merged" && l.closes_this_issue) ? "exists"
    : delivery.some((l) => l.state === "open" || l.state === "merged") || [...byKey.values()].some((l) => l.kind === "commit" && l.state === "confirmed") ? "partial" : "missing";
  const repoShort = name.split("/");
  current.set(nodeId, {
    node_id: nodeId,
    repository: name,
    number,
    url: `https://github.com/${name}/issues/${number}`,
    title: b.title,
    state: b.state,
    state_reason: b.state_reason ?? null,
    author: userOf(b.user),
    assignees: b.assignees.map(userOf).filter(Boolean),
    labels: b.labels.map((l) => (isStr(l) ? l : l?.name)).filter(isStr),
    milestone: b.milestone?.title ?? null,
    body: isStr(b.body) ? b.body : "",
    created_at: b.created_at,
    updated_at: b.updated_at,
    closed_at: b.closed_at ?? null,
    comments: cleanComments,
    events,
    links: [...byKey.values()],
    delivery_evidence: evidence,
    file: `${repoShort[0]}__${repoShort[1]}__${number}.md`,
    last_synced_at: now,
  });
}
// GitHub keeps one node ID per issue, so two entries with one ID would be a broken answer.
{
  const ids = found.map((f) => f[2]);
  if (new Set(ids).size !== ids.length) incomplete("two repositories returned the same node ID");
}

// 6. Merging with the previous run, by node ID.
const merged = {};
const moved = [];
const added = [];
const changed = [];
// Two records are the same if every field but the sync time is, whatever order the fields are in.
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
  : JSON.stringify(v));
const sameExceptTime = (a, b) => stable({ ...a, last_synced_at: null }) === stable({ ...b, last_synced_at: null });
const compareWith = new Map(); // node ID -> its previous record, compared once merging is done
for (const [id, rec] of current) {
  const old = prev.issues[id] ?? prev.no_longer_assigned[id]?.last_known_record ?? null;
  if (old) {
    // Comments and events are kept once each, by id: anything recorded before and no longer sent
    // stays, marked; nothing is added twice.
    // A comment's earlier ids (from a move) stay with it.
    const oldById = new Map((old.comments ?? []).map((c) => [c.id, c]));
    for (const c of rec.comments) if (oldById.get(c.id)?.previous_ids) c.previous_ids = oldById.get(c.id).previous_ids;
    const cNow = new Set(rec.comments.map((c) => c.id));
    for (const c of old.comments ?? []) if (!cNow.has(c.id)) rec.comments.push({ ...c, no_longer_on_github: true });
    rec.comments.sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id - y.id);
    rec.events.push(...(old.events ?? [])); // de-duplicated below, once every move is known
    if (old.previous_node_ids) rec.previous_node_ids = [...old.previous_node_ids];
    if (old.repository.toLowerCase() !== rec.repository.toLowerCase() || old.number !== rec.number) {
      moved.push(`${old.repository}#${old.number} → ${rec.repository}#${rec.number}`);
      rec.moved_from = [...(old.moved_from ?? []), { repository: old.repository, number: old.number, noticed_at: now }];
    } else if (old.moved_from) {
      rec.moved_from = old.moved_from;
    }
    if (old.file !== rec.file) rec.predecessors = [{ file: old.file, repository: old.repository, number: old.number }];
    compareWith.set(id, old);
  } else {
    added.push(`${rec.repository}#${rec.number}`);
  }
  merged[id] = rec;
}
// A different address answering at the old one counts as a move only if GitHub forwarded the
// request there: the redirect must end at that issue's own address, by name or by the
// repository's numeric id (looked up from GitHub when the repository is outside the scope).
const forwardedTo = async (r, repo, number) => {
  if (!r.redirected) return false;
  const m = r.finalPath.match(/^\/(?:repos\/([^/]+\/[^/]+)|repositories\/(\d+))\/issues\/(\d+)$/);
  if (!m || Number(m[3]) !== number) return false;
  if (m[1]) return canonName(m[1]).toLowerCase() === canonName(repo).toLowerCase();
  let id = repoIds.get(canonName(repo).toLowerCase());
  if (id === undefined) {
    const info = await get(`/repos/${canonName(repo)}`);
    if (info.status !== 200 || !isObj(info.body) || !posInt(info.body.id) || !FULL(info.body.full_name) || info.body.full_name.toLowerCase() !== canonName(repo).toLowerCase()) return false;
    id = info.body.id;
  }
  return id === Number(m[2]);
};
const alias = new Map(); // earlier node ID -> current one, for moved issues
const canon = (nid) => alias.get(nid) ?? nid;
// GitHub gives a transferred issue a new node ID (seen with the practice repositories), but its old
// address forwards to the new one. That forwarding is what links them: the issue is recorded as
// moved, keeps its earlier IDs, comments and events, and its notes go with it.
// A comment or event as it reads, without its id: after a transfer GitHub reissues ids (seen with
// the practice repositories: comment 7104002453 came back as 7104734147, same author, time and text).
const commentSig = (c) => stable([c.author, c.created_at, c.body]);
const eventSig = (e) => stable([e.event, e.at, e.actor, e.label ?? null, e.milestone ?? null, e.assignee ?? null, e.rename ?? null, e.state_reason ?? null, e.commit ?? null, e.source ? canon(e.source.node_id) : null]);
const linkMove = (old, id, there) => {
  there.moved_from = [...(old.moved_from ?? []), ...(there.moved_from ?? []), { repository: old.repository, number: old.number, node_id: id, noticed_at: now }];
  there.previous_node_ids = [...new Set([...(old.previous_node_ids ?? []), ...(there.previous_node_ids ?? []), id])];
  // The old record's comments and events are the same ones under new ids: matched one to one,
  // the same id first, then by how they read; old ids kept as provenance; anything left is kept
  // (a comment marked as no longer on GitHub).
  const taken = new Set();
  const oldComments = old.comments ?? [];
  const byId = new Map(there.comments.map((c) => [c.id, c]));
  const rest = [];
  for (const c of oldComments) { if (byId.has(c.id)) taken.add(byId.get(c.id)); else rest.push(c); }
  const unmatched = [];
  for (const c of rest) {
    const same = there.comments.find((x) => !taken.has(x) && commentSig(x) === commentSig(c));
    if (same) { taken.add(same); same.previous_ids = [...new Set([...(same.previous_ids ?? []), ...(c.previous_ids ?? []), c.id])]; }
    else unmatched.push(c);
  }
  // Edited since the last run: the same author and creation time, if exactly one comment on each
  // side has them, is the same comment (its latest text kept). Anything less certain is kept, marked.
  for (const c of unmatched) {
    const mine = (xs) => xs.filter((x) => x.author === c.author && x.created_at === c.created_at);
    const cand = mine(there.comments.filter((x) => !taken.has(x)));
    if (cand.length === 1 && mine(unmatched).length === 1) { taken.add(cand[0]); cand[0].previous_ids = [...new Set([...(cand[0].previous_ids ?? []), ...(c.previous_ids ?? []), c.id])]; }
    else there.comments.push({ ...c, no_longer_on_github: true });
  }
  const usedE = new Set();
  for (const e of old.events ?? []) {
    const same = there.events.find((x) => !usedE.has(x) && (x.key === e.key || eventSig(x) === eventSig(e)));
    if (same) usedE.add(same);
    else { there.events.push(e); usedE.add(e); }
  }
  if (old.file !== there.file) (there.predecessors ??= []).push({ file: old.file, repository: old.repository, number: old.number });
  const label = `${there.repository}#${there.number}`;
  const at = added.indexOf(label);
  if (at >= 0) added.splice(at, 1);
  moved.push(`${old.repository}#${old.number} → ${label} (new node ID; linked by GitHub's forwarding)`);
};
// Issues assigned last time and not now: looked up directly to learn why.
const noLonger = {};
const newlyGone = [];
for (const [id, old] of Object.entries(prev.issues)) {
  if (merged[id]) continue;
  let reason;
  let detail = null;
  const scopeEntry = byLowerName.get(old.repository.toLowerCase());
  if (!scopeEntry) {
    const listed = repos.some((f) => [f, repoInfo[f].full_name, prev.repositories[f]?.full_name].some((x) => isStr(x) && x.toLowerCase() === old.repository.toLowerCase()));
    reason = listed ? "inaccessible" : "out of scope";
    detail = listed ? `the repository ${old.repository} couldn't be read this run` : `the repository ${old.repository} is no longer in the scope list`;
  } else {
    const oldName = canonName(old.repository);
    const r = await get(`/repos/${oldName}/issues/${old.number}`);
    if (r.status === 200) {
      checkIssueBody(r.body, `looking up ${old.repository}#${old.number}`);
      const b = r.body;
      const nowRepo = repoFromApiUrl(b.repository_url);
      // GitHub forwards a moved issue's old address: a different address answering means it moved
      // (to another repository, or to a new number in the same one).
      const sameAddress = canonName(nowRepo).toLowerCase() === oldName.toLowerCase() && b.number === old.number;
      if (sameAddress && b.node_id !== id) {
        reason = "inaccessible";
        detail = "the number now belongs to a different issue";
      } else if (!sameAddress && !(await forwardedTo(r, nowRepo, b.number))) {
        incomplete(`looking up ${old.repository}#${old.number}: GitHub answered for ${nowRepo}#${b.number} without forwarding there`);
      } else if (!sameAddress) {
        reason = "transferred";
        detail = `moved to ${nowRepo}#${b.number}${byLowerName.has(nowRepo.toLowerCase()) ? "" : " (outside the scope list)"}`;
        const there = Object.values(merged).find((m) => m.repository.toLowerCase() === canonName(nowRepo).toLowerCase() && m.number === b.number);
        if (there && there.node_id === b.node_id) { linkMove(old, id, there); continue; }
        if (there) {
          detail += "; GitHub gave it a new node ID there, so it is also recorded as a new issue";
        } else if (byLowerName.has(nowRepo.toLowerCase()) && b.state === "open" && (b.assignees ?? []).some((a) => a?.id === me.id)) {
          incomplete(`${old.repository}#${old.number} moved to ${nowRepo}#${b.number}, which is open and assigned, but the search didn't return it yet (GitHub's search index is behind); run again in a minute`);
        }
      } else if (b.state === "closed") {
        reason = "closed";
        detail = `closed ${shown(b.closed_at)}${b.state_reason ? ` (${b.state_reason})` : ""}`;
      } else if (!b.assignees.some((a) => a.id === me.id)) {
        reason = "unassigned";
        detail = b.assignees.length ? `now assigned to ${b.assignees.map(userOf).join(", ")}` : "now assigned to no one";
      } else {
        incomplete(`${old.repository}#${old.number} is open and assigned, but the search didn't return it (GitHub's search index is behind); run again in a minute`);
      }
    } else if ([403, 404, 410].includes(r.status)) {
      reason = "inaccessible";
      detail = `GitHub answered ${r.status} (deleted, or this token can no longer see it)`;
    } else {
      incomplete(`looking up ${old.repository}#${old.number}: GitHub answered ${r.status}${said(r)}`);
    }
  }
  noLonger[id] = { node_id: id, repository: old.repository, number: old.number, title: old.title, reason, detail, detected_at: now, last_known_record: old };
  newlyGone.push(`${old.repository}#${old.number} (${reason})`);
}
// An issue listed as no longer assigned may since have moved and been assigned again (or been
// archived while its repository couldn't be read): each archived one whose repository is readable
// is looked up at its old address, and one that forwards to an issue recorded now is linked to it
// (its notes go with it) instead of staying archived.
const returnedMoved = [];
for (const [id, r] of Object.entries(prev.no_longer_assigned)) {
  if (merged[id] || noLonger[id]) continue;
  const old = r.last_known_record;
  if (byLowerName.has(old.repository.toLowerCase())) {
    const oldName = canonName(old.repository);
    const look = await get(`/repos/${oldName}/issues/${old.number}`);
    if (look.status === 200) {
      checkIssueBody(look.body, `looking up ${old.repository}#${old.number}`);
      const b = look.body;
      const nowRepo = canonName(repoFromApiUrl(b.repository_url));
      const sameAddress = nowRepo.toLowerCase() === oldName.toLowerCase() && b.number === old.number;
      const there = Object.values(merged).find((m) => m.repository.toLowerCase() === nowRepo.toLowerCase() && m.number === b.number);
      if (!sameAddress && !(await forwardedTo(look, nowRepo, b.number))) incomplete(`looking up ${old.repository}#${old.number}: GitHub answered for ${nowRepo}#${b.number} without forwarding there`);
      if (!sameAddress && there && there.node_id === b.node_id && there.node_id !== id) {
        linkMove(old, id, there);
        returnedMoved.push(`${there.repository}#${there.number}`);
        continue;
      }
      // Open and assigned again, in scope, yet not found by the search: the search is behind.
      if (!there && byLowerName.has(nowRepo.toLowerCase()) && b.state === "open" && b.assignees.some((a) => a.id === me.id)) {
        incomplete(`${old.repository}#${old.number} is open and assigned again, but the search didn't return it (GitHub's search index is behind); run again in a minute`);
      }
    } else if (![403, 404, 410].includes(look.status)) {
      incomplete(`looking up ${old.repository}#${old.number}: GitHub answered ${look.status}${said(look)}`);
    }
  }
  noLonger[id] = r;
}
// Comments and events are kept once each. An event that came from a moved issue's earlier
// address is the same event: a cross-reference's source is compared by the issue it points to,
// with earlier node IDs mapped to the current one.
alias.clear();
for (const rec of Object.values(merged)) for (const old of rec.previous_node_ids ?? []) alias.set(old, rec.node_id);
// A cross-reference whose source issue moved (not one of mine) comes back pointing at the source's
// new address and node ID. Where two cross-references share their time and actor but point at
// different sources, the older source's address is looked up: if it forwards to the other, they
// are one source, and one event.
const sourceLook = new Map();
for (const rec of Object.values(merged)) {
  const xs = rec.events.filter((e) => e.event === "cross-referenced" && !e.key.startsWith("id:") && e.source);
  for (const a of xs) for (const b of xs) {
    if (a === b || a.at !== b.at || a.actor !== b.actor || canon(a.source.node_id) === canon(b.source.node_id)) continue;
    if (!byLowerName.has(a.source.repository.toLowerCase())) continue;
    const k = `${a.source.repository}#${a.source.number}`.toLowerCase();
    if (!sourceLook.has(k)) {
      const r = await get(`/repos/${canonName(a.source.repository)}/issues/${a.source.number}`);
      if (r.status === 200) { checkIssueBody(r.body, `looking up ${k}`); sourceLook.set(k, { repo: canonName(repoFromApiUrl(r.body.repository_url)), number: r.body.number, node: r.body.node_id }); }
      else if ([403, 404, 410].includes(r.status)) sourceLook.set(k, null);
      else incomplete(`looking up ${k}: GitHub answered ${r.status}${said(r)}`);
    }
    const now2 = sourceLook.get(k);
    if (now2 && now2.node === b.source.node_id && now2.number === b.source.number && now2.repo.toLowerCase() === canonName(b.source.repository).toLowerCase()) alias.set(a.source.node_id, b.source.node_id);
  }
}
const eventId = (e) => (e.key.startsWith("id:") ? e.key : `${e.event}:${e.at}:${canon(e.source?.node_id ?? "")}`);
for (const rec of Object.values(merged)) {
  const seenC = new Set();
  rec.comments = rec.comments.filter((c) => !seenC.has(c.id) && seenC.add(c.id));
  rec.comments.sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id - y.id);
  const seenE = new Set();
  rec.events = rec.events.filter((e) => { const k = eventId(e); return !seenE.has(k) && seenE.add(k); });
  rec.events.sort((x, y) => String(x.at).localeCompare(String(y.at)) || eventId(x).localeCompare(eventId(y)));
}
const returned = [...Object.keys(prev.no_longer_assigned).filter((id) => merged[id]).map((id) => `${merged[id].repository}#${merged[id].number}`), ...returnedMoved];
for (const [id, old] of compareWith) {
  const rec = merged[id];
  if (!prev.issues[id] || !sameExceptTime(old, { ...rec, predecessors: undefined })) changed.push(`${rec.repository}#${rec.number}`);
}

// Per repository: the last successful synchronization (kept from before for one that couldn't
// be read this run).
const repoState = {};
for (const full of repos) {
  const info = repoInfo[full];
  repoState[full] = info.readable
    ? { readable: true, full_name: info.full_name, last_successful_sync: now, ...(info.note ? { note: info.note } : {}), search: searchReport[full] }
    : { readable: false, reason: info.reason, last_successful_sync: prev.repositories[full]?.last_successful_sync ?? null, ...(isStr(prev.repositories[full]?.full_name) ? { full_name: prev.repositories[full].full_name } : {}) };
}

// ---- writing the files --------------------------------------------------------------------------
// Untrusted text (titles, bodies, comments) is shown as plain characters: one-line text has every
// Markdown or HTML mark escaped; longer text goes in an indented code block, where nothing is
// interpreted, and no line of it can match the notes line.
const text = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/[!-&(-+./:-@[-`{-~]/g, "\\$&");
const block = (v) => {
  const s = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "�");
  if (s.trim() === "") return "    (empty)";
  return s.split("\n").map((l) => `    ${l}`).join("\n");
};
const code = (v) => `\`${String(v).replace(/[`\u0000-\u001f\u007f]/g, "")}\``;
const notesStart = (rec) => `## My notes\n\nYour own notes on ${text(rec.repository)}\\#${rec.number}. The synchronization never changes this section.\n`;
const linkLine = (l) => {
  if (l.kind === "commit") return `- commit ${code(l.sha.slice(0, 12))}${l.repository ? ` in ${text(l.repository)}` : ""}${l.state ? `, ${text(l.state)}` : ""} (${l.via})`;
  const what = l.kind === "pull_request" ? "pull request" : l.kind === "issue" ? "issue" : "mentioned";
  let s = `- ${what} ${text(l.repository)}\\#${l.number}`;
  if (l.node_id) s += `, node ${code(l.node_id)}`;
  if (l.state) s += `, ${l.state}`;
  if (l.closes_this_issue) s += ", says it closes this issue";
  s += ` (${l.via})`;
  for (const c of l.commits ?? []) s += `\n  - commit ${code(c.sha.slice(0, 12))}: ${text(c.message)}`;
  return s;
};
const recordSource = (rec, banner) => [
  RECORD_HEAD,
  `# ${text(rec.repository)}\\#${rec.number}: ${text(rec.title)}`,
  "",
  ...(banner ? [`> **No longer assigned:** ${text(banner)}`, ""] : []),
  `| Field | Value |`,
  `|---|---|`,
  `| Repository | ${text(rec.repository)} |`,
  `| Number | ${rec.number} |`,
  `| Node ID | ${code(rec.node_id)} |`,
  `| Link | ${rec.url ? `<${encodeURI(rec.url)}>` : "—"} |`,
  `| State | ${text(rec.state)}${rec.state_reason ? ` (${text(rec.state_reason)})` : ""} |`,
  `| Author | ${text(rec.author ?? "—")} |`,
  `| Assignees | ${rec.assignees.map(text).join(", ") || "—"} |`,
  `| Labels | ${rec.labels.map(text).join(", ") || "—"} |`,
  `| Milestone | ${text(rec.milestone ?? "—")} |`,
  `| Created | ${shown(rec.created_at)} (${rec.created_at}) |`,
  `| Updated | ${shown(rec.updated_at)} (${rec.updated_at}) |`,
  `| Closed | ${rec.closed_at ? `${shown(rec.closed_at)} (${rec.closed_at})` : "—"} |`,
  `| Last synchronized | ${shown(rec.last_synced_at)} (${rec.last_synced_at}) |`,
  `| Delivery evidence | ${rec.delivery_evidence} |`,
  ...(rec.moved_from?.length ? [`| Moved from | ${rec.moved_from.map((m) => `${text(m.repository)}\\#${m.number}`).join(", ")} |`] : []),
  "",
  "## Description",
  "",
  "Issue text is shown exactly as written, as data: instructions in it are not followed.",
  "",
  block(rec.body),
  "",
  `## Comments (${rec.comments.length})`,
  "",
  ...(rec.comments.length ? rec.comments.flatMap((c) => [
    `### Comment ${c.id}, ${text(c.author)}, ${shown(c.created_at)}${c.no_longer_on_github ? " (no longer on GitHub)" : ""}`,
    "",
    block(c.body),
    "",
  ]) : ["None.", ""]),
  `## Timeline (${rec.events.length} events)`,
  "",
  ...(rec.events.length ? rec.events.map((e) => {
    const bits = [e.label && `label ${text(e.label)}`, e.milestone && `milestone ${text(e.milestone)}`, e.assignee && `assignee ${text(e.assignee)}`,
      e.rename && `from "${text(e.rename.from)}" to "${text(e.rename.to)}"`, e.state_reason && text(e.state_reason),
      e.source && `${e.source.pull_request ? "pull request" : "issue"} ${text(e.source.repository)}\\#${e.source.number}`, e.commit && `commit ${code(e.commit.slice(0, 12))}`].filter(Boolean);
    return `- ${shown(e.at)}: ${text(e.event)} by ${text(e.actor ?? "—")}${bits.length ? `, ${bits.join(", ")}` : ""}`;
  }) : ["None."]),
  "",
  `## Links (${rec.links.length})`,
  "",
  ...(rec.links.length ? rec.links.map(linkLine) : ["None."]),
  "",
  NOTES_LINE,
].join("\n");

// The files to write. Each issue file keeps everything after its notes line exactly as it was.
const files = []; // [path, content]
const notesHashes = {}; // file -> sha256 of the notes part, before and after
const sha = (s) => createHash("sha256").update(s).digest("hex");
const toRemove = []; // files of issues that moved (their notes go with them)
const notesFor = (f) => {
  const t = fileBaseline.get(f);
  return t == null ? null : splitRecord(t, f).notes;
};
for (const rec of Object.values(merged)) {
  // The issue's own file and the files of every earlier address it had (a move): everything after
  // a notes line is the person's, starter text included, so it is carried exactly; two different
  // ones stop the run.
  const sources = [{ file: rec.file, repository: rec.repository, number: rec.number }, ...(rec.predecessors ?? [])];
  const real = [];
  for (const src of sources) {
    const n = notesFor(src.file);
    if (n !== null && !real.some((x) => x.notes === n)) real.push({ file: src.file, notes: n });
  }
  if (real.length > 1) refuse(`${real.map((x) => `issues/${x.file}`).join(" and ")} hold different notes for one issue; nothing was written. Combine them, then run again.`);
  const body = real[0]?.notes ?? notesStart(rec);
  for (const src of rec.predecessors ?? []) if (src.file !== rec.file && fileBaseline.get(src.file) != null && !toRemove.includes(src.file)) toRemove.push(src.file);
  notesHashes[rec.file] = sha(body);
  files.push([join(issuesDir, rec.file), `${recordSource(rec)}\n${body}`]);
  delete rec.predecessors;
}
for (const r of Object.values(noLonger)) {
  const rec = r.last_known_record;
  const notes = notesFor(rec.file);
  const body = notes ?? notesStart(rec);
  notesHashes[rec.file] = sha(body);
  files.push([join(issuesDir, rec.file), `${recordSource(rec, `${r.reason}: ${r.detail}; noticed ${shown(r.detected_at)}. Last known record below.`)}\n${body}`]);
}
{
  const names = files.map(([p]) => p);
  if (new Set(names).size !== names.length) refuse("Two issues would share one file name; nothing was written.");
}

const byRepo = (list) => {
  const g = new Map();
  for (const r of list) {
    if (!g.has(r.repository)) g.set(r.repository, []);
    g.get(r.repository).push(r);
  }
  for (const l of g.values()) l.sort((a, b) => a.number - b.number);
  return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
};
const totalDeclared = Object.values(searchReport).reduce((n, s) => n + s.declared, 0);
const totalReceived = Object.values(searchReport).reduce((n, s) => n + s.received, 0);
const prsExcluded = Object.entries(searchReport).flatMap(([f, s]) => s.pull_requests_assigned.map((n) => `${repoInfo[f].full_name}#${n}`));
const prsLeaked = Object.entries(searchReport).flatMap(([f, s]) => s.pull_requests_in_issue_search.map((n) => `${repoInfo[f].full_name}#${n}`));
const unreadable = repos.filter((f) => !repoInfo[f].readable);
const summary = {
  synchronized_at: now,
  identity: { login: me.login, id: me.id, access: tokenKind },
  repositories_in_scope: repos.length,
  repositories_unreadable: unreadable.map((f) => `${f} (${repoInfo[f].reason})`),
  pages_read: Object.values(searchReport).reduce((n, s) => n + s.pages, 0),
  total_declared_by_github: totalDeclared,
  total_received: totalReceived,
  complete: totalDeclared === totalReceived,
  pull_requests_assigned_not_counted: prsExcluded,
  pull_requests_dropped_from_issue_search: prsLeaked,
  issues_assigned: Object.keys(merged).length,
  added,
  changed,
  moved,
  newly_no_longer_assigned: newlyGone,
  returned,
  search_was_behind: searchBehind,
  requests,
};
const index = [
  INDEX_HEAD,
  "# GitHub issues assigned to me",
  "",
  `Synchronized ${shown(now)} as ${text(me.login)}, read-only. Generated: the synchronization rewrites this file. Notes go in each issue's own file, under "My notes".`,
  "",
  `GitHub declared ${totalDeclared} open issues assigned to ${text(me.login)} across the readable repositories and ${totalReceived} arrived, over ${summary.pages_read} pages, so the list is ${summary.complete ? "complete" : "NOT complete"}. Pull requests are not issues: ${prsExcluded.length} assigned ${prsExcluded.length === 1 ? "pull request was" : "pull requests were"} found by a separate search and left out (${prsExcluded.map((p) => text(p)).join(", ") || "none"}); the issue search itself returned ${prsLeaked.length ? `${prsLeaked.length} (dropped: ${prsLeaked.map((p) => text(p)).join(", ")})` : "none"}.`,
  "",
  "## Repositories",
  "",
  "| Repository | Read | Issue pages | Issues declared | Issues received | Assigned pull requests (left out) | Last successful synchronization |",
  "|---|---|---|---|---|---|---|",
  ...repos.map((f) => {
    const s = repoState[f];
    return s.readable
      ? `| ${text(s.full_name)} | yes | ${s.search.pages} | ${s.search.declared} | ${s.search.received} | ${s.search.pull_requests_assigned.map((n) => `\\#${n}`).join(", ") || "none"} | ${shown(s.last_successful_sync)} |`
      : `| ${text(f)} | **no: ${text(s.reason)}** | — | — | — | — | ${s.last_successful_sync ? shown(s.last_successful_sync) : "never"} |`;
  }),
  "",
  ...byRepo(Object.values(merged)).flatMap(([repo, list]) => [
    `## ${text(repo)}`,
    "",
    "| Issue | Title | Labels | Milestone | Updated | Delivery evidence | Record |",
    "|---|---|---|---|---|---|---|",
    ...list.map((r) => `| \\#${r.number} | ${text(r.title)} | ${r.labels.map(text).join(", ") || "—"} | ${text(r.milestone ?? "—")} | ${shown(r.updated_at)} | ${r.delivery_evidence} | [${text(r.file)}](issues/${r.file}) |`),
    "",
  ]),
  "## No longer assigned",
  "",
  ...(Object.keys(noLonger).length ? [
    "Kept, never deleted: each with why it left and its last known record (in its file).",
    "",
    "| Issue | Last known title | Why | Noticed | Record |",
    "|---|---|---|---|---|",
    ...Object.values(noLonger).sort((a, b) => `${a.repository}#${a.number}`.localeCompare(`${b.repository}#${b.number}`))
      .map((r) => `| ${text(r.repository)}\\#${r.number} | ${text(r.title)} | ${text(r.reason)}: ${text(r.detail)} | ${shown(r.detected_at)} | [${text(r.last_known_record.file)}](issues/${r.last_known_record.file}) |`),
  ] : ["None."]),
  "",
].join("\n");
const links = [
  LINKS_HEAD,
  "# Delivery links",
  "",
  `Synchronized ${shown(now)}. For each assigned issue: the pull requests, commits and issues linked to it, and whether delivery evidence exists (a merged pull request that says it closes the issue), is partial (an open pull request or a commit), or is missing. Checks are not read: the token has no permission for them.`,
  "",
  ...byRepo(Object.values(merged)).flatMap(([, list]) => list.flatMap((r) => [
    `## ${text(r.repository)}\\#${r.number}: ${text(r.title)}`,
    "",
    `Delivery evidence: **${r.delivery_evidence}**`,
    "",
    ...(r.links.length ? r.links.map(linkLine) : ["No links."]),
    "",
  ])),
].join("\n");
const state = {
  tool: "github-sync",
  schema: 1,
  synchronized_at: now,
  identity: { login: me.login, id: me.id },
  scope: repos,
  repositories: repoState,
  summary,
  issues: Object.fromEntries(Object.entries(merged).sort()),
  no_longer_assigned: Object.fromEntries(Object.entries(noLonger).sort()),
};
files.push([indexPath, index], [linksPath, links], [statePath, `${JSON.stringify(state, null, 2)}\n`]);

// ---- publishing: all together, or nothing -------------------------------------------------------
const writeNew = (path, content, mode = 0o644) => {
  const fd = openSync(path, "wx", mode);
  try {
    try {
      const bytes = Buffer.from(content, "utf8");
      let done = 0;
      while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try { unlinkSync(path); } catch { /* already gone */ }
    throw err;
  }
};
const dirsCreated = [];
const lockPath = join(out, ".github-sync.lock");
const lockText = `pid ${process.pid}, started ${now}\n`;
let lockHeld = false;
const releaseLock = () => {
  if (lockHeld) try { if (readOrdinary(lockPath) === lockText) unlinkSync(lockPath); } catch { /* gone */ }
  lockHeld = false;
};
const undo = () => {
  releaseLock();
  for (const d of [...dirsCreated].reverse()) try { rmdirSync(d); } catch { /* not empty or gone */ }
};
const stopUnderLock = (message) => { undo(); refuse(message); };
process.on("exit", releaseLock);
// Anything unexpected from here on (a permission error, say) still removes the lock and the
// folders this run made, and says nothing was changed only if that is true.
process.on("uncaughtException", (err) => {
  undo();
  console.error(`Stopped by an unexpected error (${err.code ?? err.message}); ${publishing ? "check the folder" : "nothing was written"}.`);
  process.exit(2);
});
let publishing = false;
for (const [n, dir] of missingDirs.entries()) {
  const made = mkdirSync(dir, { recursive: n === 0 && !inRepo });
  if (made && made !== dir) for (let d = dir; d.length >= made.length; d = dirname(d)) dirsCreated.unshift(d);
  else dirsCreated.push(dir);
}
try {
  writeNew(lockPath, lockText);
  lockHeld = true;
} catch (err) {
  if (err.code !== "EEXIST") throw err;
  stopUnderLock("Another synchronization is writing to this folder, or one stopped and left .github-sync.lock for a person to check; nothing was written. If none is running and the folder is fine, remove the lock and run again.");
}
// Holding the lock: nothing read at the start has changed, and every target is still an ordinary
// file this tool wrote (or absent).
checkDirs(stopUnderLock);
if (whereReally() !== outReally) stopUnderLock("The output folder's location changed (a parent folder swapped for a link?); nothing was written.");
for (const [path, t] of rootAtStart) if (readOrdinary(path) !== t) stopUnderLock(`${relative(out, path)} changed while this run was reading GitHub; nothing was written. Run again.`);
if (readOrdinary(statePath) !== stateText) stopUnderLock("sync-state.json changed while this run was reading GitHub; nothing was written. Run again.");
for (const [f, t] of fileBaseline) if (readOrdinary(join(issuesDir, f)) !== t) stopUnderLock(`issues/${f} changed while this run was reading GitHub (a note being typed?); nothing was written. Run again.`);
for (const [path] of files) {
  if (fileBaseline.has(relative(issuesDir, path))) continue;
  const t = readOrdinary(path);
  if (t === NOT_ORDINARY) stopUnderLock(`${relative(out, path)} isn't an ordinary UTF-8 text file; nothing was written.`);
  if (t !== null && path !== indexPath && path !== linksPath && path !== statePath) stopUnderLock(`${relative(out, path)} already exists and this tool doesn't know it; nothing was written. Move it, then run again.`);
  if (t !== null && path === indexPath && !t.startsWith(`${INDEX_HEAD}\n`)) stopUnderLock("index.md wasn't written by this tool; nothing was written.");
  if (t !== null && path === linksPath && !t.startsWith(`${LINKS_HEAD}\n`)) stopUnderLock("delivery-links.md wasn't written by this tool; nothing was written.");
}
// No file may hold the token itself (say, pasted into an issue by accident): its value is never
// printed, and nothing is written.
for (const [path, content] of files) {
  if (content.includes(TOKEN)) stopUnderLock(`${relative(out, path)} would contain the token itself (it is in an issue's text on GitHub?); nothing was written. Remove it there and replace the token.`);
}
// Every issue file about to be written must split at exactly one notes line, with notes exactly
// as planned, before anything is published.
for (const [path, content] of files) {
  const f = relative(issuesDir, path);
  if (!(f in notesHashes)) continue;
  const sp = splitRecord(content, `issues/${f}`);
  if (sp.error || sha(sp.notes) !== notesHashes[f]) stopUnderLock(`issues/${f} would not keep its notes exactly (${sp.error ?? "they differ"}); nothing was written.`);
}
// What each file was when this run read it: a file replaced by the swap below must still have
// been exactly that, or someone saved it meanwhile and everything is put back.
const readAtStart = new Map([[statePath, stateText], ...rootAtStart]);
for (const [path] of files) if (dirname(path) === issuesDir) readAtStart.set(path, fileBaseline.get(relative(issuesDir, path)) ?? null);
class Conflict extends Error {}
const staged = [];
const swapped = [];
const removedOld = [];
publishing = true;
try {
  for (const [path, content] of files) {
    const tmp = `${path}.${process.pid}.new`;
    // A file someone made stricter (say, owner-only) stays that strict; a new one gets the
    // repository's usual permissions.
    let mode = 0o644;
    try { mode = lstatSync(path).mode & 0o666; } catch { /* new file */ }
    writeNew(tmp, content, mode);
    staged.push([tmp, path]);
  }
  for (const [tmp, path] of staged) {
    const old = `${path}.${process.pid}.old`;
    let kept = old;
    try { linkSync(path, old); } catch (err) { if (err.code !== "ENOENT") throw err; kept = null; }
    const entry = [path, kept, false];
    swapped.push(entry);
    renameSync(tmp, path);
    entry[2] = true;
    if (readAtStart.has(path) && (kept ? readOrdinary(kept) : null) !== readAtStart.get(path)) {
      throw new Conflict(`${relative(out, path)} was saved by someone while this run was writing`);
    }
  }
  // The files of issues that moved: their notes now live in the new file.
  for (const f of toRemove) {
    const p = join(issuesDir, f);
    renameSync(p, `${p}.${process.pid}.old`);
    removedOld.push(p);
    if (readOrdinary(`${p}.${process.pid}.old`) !== fileBaseline.get(f)) throw new Conflict(`issues/${f} was saved by someone while this run was writing`);
  }
  // Read back: every notes section exactly as planned, before any previous version is let go.
  for (const [f, h] of Object.entries(notesHashes)) {
    const t = readOrdinary(join(issuesDir, f));
    const sp = typeof t === "string" ? splitRecord(t, f) : { error: "unreadable" };
    if (sp.error || sha(sp.notes) !== h) throw new Error(`the notes in issues/${f} didn't read back exactly`);
  }
} catch (err) {
  const notPutBack = [];
  const keptAside = [];
  const written = new Map(files);
  for (const p of removedOld.reverse()) {
    // Someone recreated this file after it was moved away: that save is kept aside first.
    if (readOrdinary(p) !== null) {
      try { renameSync(p, `${p}.${process.pid}.saved`); keptAside.push(relative(out, `${p}.${process.pid}.saved`)); } catch { notPutBack.push(relative(out, p)); continue; }
    }
    try { renameSync(`${p}.${process.pid}.old`, p); } catch { notPutBack.push(relative(out, p)); }
  }
  for (const [path, kept, replaced] of swapped.reverse()) {
    // Someone saved this file after it was swapped in: that save is kept aside, never overwritten.
    if (replaced && readOrdinary(path) !== written.get(path)) {
      const aside = `${path}.${process.pid}.saved`;
      try { linkSync(path, aside); keptAside.push(relative(out, aside)); } catch { notPutBack.push(relative(out, path)); continue; }
    }
    try {
      if (replaced && kept) renameSync(kept, path);
      else if (replaced) unlinkSync(path);
      else if (kept) unlinkSync(kept);
    } catch {
      if (replaced) notPutBack.push(kept ? `${relative(out, path)} (the previous one is kept as ${relative(out, kept)})` : relative(out, path));
    }
  }
  for (const [tmp] of staged) try { unlinkSync(tmp); } catch { /* moved or gone */ }
  if (notPutBack.length || keptAside.length) {
    lockHeld = false; // kept on purpose: a person should look before another run changes the folder
    console.error(`Stopped (${err instanceof Conflict ? err.message : err.code ?? err.message}).${notPutBack.length ? ` These couldn't be put back: ${notPutBack.join("; ")}.` : ""}${keptAside.length ? ` A save made after a file was written is kept as: ${keptAside.join("; ")}; the previous files were put back.` : ""} The lock is kept; check the folder, then remove .github-sync.lock.`);
    process.exit(2);
  }
  undo();
  console.error(err instanceof Conflict
    ? `Stopped: ${err.message}; the previous files (with that save) were put back; nothing was changed. Run again.`
    : `Writing failed (${err.code ?? err.message}); the previous files were put back; nothing was changed.`);
  process.exit(2);
}
for (const [, kept] of swapped) if (kept) try { unlinkSync(kept); } catch { /* gone */ }
for (const p of removedOld) try { unlinkSync(`${p}.${process.pid}.old`); } catch { /* gone */ }
releaseLock();

// ---- the run report (no token, no raw response) -------------------------------------------------
const list = (l) => (l.length ? l.join(", ") : "none");
console.log(`Synchronized ${shown(now)} as ${me.login} (${tokenKind}).`);
console.log(`Scope: ${repos.length} repositories; unreadable: ${list(summary.repositories_unreadable)}.`);
for (const f of readable) {
  const s = searchReport[f];
  console.log(`  ${repoInfo[f].full_name}: issues: ${s.pages} page(s) of ${opts.perPage}, GitHub declared ${s.declared}, received ${s.received}, kept ${s.issues}; assigned pull requests, searched separately and left out: ${list(s.pull_requests_assigned.map((n) => `#${n}`))}; pull requests the issue search returned: ${list(s.pull_requests_in_issue_search.map((n) => `#${n}`))}.`);
}
console.log(`Total issues: declared ${totalDeclared}, received ${totalReceived} over ${summary.pages_read} pages (${summary.complete ? "complete" : "NOT complete"}); ${Object.keys(merged).length} issues assigned.`);
console.log(`This run: new ${list(added)}; changed ${list(changed)}; moved ${list(moved)}; no longer assigned ${list(newlyGone)}; returned ${list(returned)}; search behind ${list(searchBehind)}.`);
console.log(`Kept as no longer assigned: ${Object.keys(noLonger).length}. Notes sections kept exactly (read back): ${Object.keys(notesHashes).length} of ${Object.keys(notesHashes).length}.`);
console.log(`Requests to GitHub: ${requests}, all GET.`);
