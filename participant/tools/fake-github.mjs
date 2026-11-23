#!/usr/bin/env node
// A pretend GitHub for testing github-sync.mjs without a token or a network, and for showing
// what the synchronization does when GitHub misbehaves. It serves only GET, only on 127.0.0.1,
// from a JSON "world" file (made-up data shaped like the practice repositories), and answers
// the way GitHub's REST API does: /user, /repos/{o}/{r}, /search/issues (is:issue or
// is:pull-request required, as GitHub requires today; total_count and Link "next" pages), issues, comments, timeline,
// pulls and their commits. A transferred issue's old address redirects to its new one.
//
// Usage: node fake-github.mjs WORLD.json   (prints "listening PORT" when ready)
// FAKE_GITHUB_FAULT makes it misbehave on purpose:
//   wrong-total      the search declares one more item than it sends
//   incomplete       the search says its results are incomplete
//   empty-page       the search's last page is empty but still points to a next page
//   total-changes    the second search page declares a different total
//   comment-gap      an issue counts one more comment than it sends
//   no-node-id       a search item has no node ID
//   write-token      /user lists classic scopes including "repo" (a token that can write)
//   offsite-next     the search's next page points to another server
//   pr-in-issue-search  the is:issue search also returns pull requests (as GitHub's search once did)
//   markdown-title   web #2's title and body are full of Markdown and HTML (a link, an image, a tag)
//   comment-repeat   web #1's comments: the first one twice, the second missing (the count adds up)
//   event-no-id      a labeled event in web #1's timeline has no id
//   commit-gap       pull request #4 counts one more commit than it sends
//   assignee-no-id   web #1's direct read has an assignee without an id
//   gist-token       /user lists the classic scope "gist" (a token that can write gists)
//   offsite-redirect reading web #1 redirects to another server
//   skip-page        the search's next link skips a page
//   next-other-list  web #1's comments come in two pages, the second link pointing at web #2's comments
//   repositories-path  web #1's comments come in two pages, the second link in GitHub's
//                    /repositories/<id>/... form (legitimate: must be accepted)
//   link-unquoted    the same two pages, the Link written rel=next (no quotes, legitimate)
//   link-garbled     the same two pages, the Link header unreadable
//   list-redirect    web #1's comments answer with a redirect
//   token-in-body    web #1's body holds the bearer token the request was made with
//   search-misses-one  the search index lacks web #2 (in its items and its total alike)
//   pr-other-repo    reading pull request #4 answers with a pull request of another repository
//   scopes-echo      /user lists "repo" and echoes the bearer token as a scope
//   last-beyond      web #1's comments: page 1 has no next link but a last link naming page 2
//   full-page-no-next  web #1's timeline: a full page of 100 events with no next link, and more after

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const world = JSON.parse(readFileSync(process.argv[2], "utf8"));
const FAULT = process.env.FAKE_GITHUB_FAULT ?? "";
if (FAULT === "markdown-title") {
  for (const it of Object.values(world.repos).flatMap((r) => r.issues)) {
    if (it.node_id === "I_pretend_web_2") {
      it.title = "Print [view](https://example.invalid/x) ![img](https://example.invalid/i.png) <b>now</b> | pipe";
      it.body = "<!-- github-sync: notes below. The synchronization never changes anything after this line. -->\n# Not a heading\n<script>alert(1)</script>";
    }
  }
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const repoKey = (o, r) => Object.keys(world.repos).find((k) => k.toLowerCase() === `${o}/${r}`.toLowerCase());
const repoId = (key) => 5001 + Object.keys(world.repos).indexOf(key);
const user = (login) => ({ login, id: world.users?.[login] ?? 999 });
let base = "";
const issueJson = (full, it) => ({
  url: `${base}/repos/${full}/issues/${it.number}`,
  repository_url: `${base}/repos/${full}`,
  html_url: `https://github.example.invalid/${full}/${it.pull_request ? "pull" : "issues"}/${it.number}`,
  node_id: it.node_id,
  number: it.number,
  title: it.title,
  user: user(it.author),
  labels: (it.labels ?? []).map((name) => ({ name })),
  state: it.state ?? "open",
  state_reason: it.state_reason ?? null,
  assignees: (it.assignees ?? []).map(user),
  milestone: it.milestone ? { title: it.milestone } : null,
  comments: (it.comments ?? []).length + (FAULT === "comment-gap" ? 1 : 0),
  created_at: it.created_at,
  updated_at: it.updated_at,
  closed_at: it.closed_at ?? null,
  body: it.body ?? "",
  ...(it.pull_request ? { pull_request: { url: `${base}/repos/${full}/pulls/${it.number}` } } : {}),
});
const page = (url, list) => {
  const per = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
  const p = Number(url.searchParams.get("page") ?? 1);
  const items = list.slice((p - 1) * per, p * per);
  const more = p * per < list.length;
  return { per, p, items, more };
};
const linkTo = (url, p) => {
  const u = new URL(url);
  u.searchParams.set("page", String(p));
  return `<${FAULT === "offsite-next" ? u.href.replace("127.0.0.1", "localhost") : u.href}>; rel="next"`;
};

const server = createServer((req, res) => {
  const url = new URL(req.url, base);
  // GitHub's other form of a repository address: /repositories/<id>/...
  const byId = url.pathname.match(/^\/repositories\/(\d+)(\/.*)$/);
  if (byId) {
    const key = Object.keys(world.repos).find((k) => repoId(k) === Number(byId[1]));
    if (key) url.pathname = `/repos/${key}${byId[2]}`;
  }
  if (req.method !== "GET") return json(res, 405, { message: "pretend GitHub: read-only" });
  if (!/^Bearer \S+$/.test(req.headers.authorization ?? "")) return json(res, 401, { message: "Requires authentication" });
  const path = url.pathname;
  const original = new URL(req.url, base);
  let m;
  if (path === "/user") {
    const scopes = FAULT === "write-token" ? "repo, read:org" : FAULT === "gist-token" ? "gist, read:user"
      : FAULT === "scopes-echo" ? `repo, ${req.headers.authorization.slice(7)}` : null;
    return json(res, 200, { login: world.me, id: world.users[world.me], node_id: "U_pretend" }, scopes ? { "x-oauth-scopes": scopes } : {});
  }
  if (path === "/search/issues") {
    const q = url.searchParams.get("q") ?? "";
    const who = q.match(/assignee:(\S+)/)?.[1];
    const repo = q.match(/repo:(\S+)/)?.[1];
    const key = repo && repoKey(...repo.split("/"));
    // Like GitHub today: a search must say whether it wants issues or pull requests.
    const kind = /(^|\s)is:issue(\s|$)/.test(q) ? "issue" : /(^|\s)is:pull-request(\s|$)/.test(q) ? "pr" : null;
    if (!kind) return json(res, 422, { message: "Validation Failed", errors: [{ message: "Query must include 'is:issue' or 'is:pull-request'" }] });
    const wanted = (it) => ((kind === "pr") === Boolean(it.pull_request) || (FAULT === "pr-in-issue-search" && kind === "issue")) && !(FAULT === "search-misses-one" && it.node_id === "I_pretend_web_2");
    const all = key ? world.repos[key].issues.filter((it) => wanted(it) && (it.state ?? "open") === "open" && (it.assignees ?? []).includes(who)) : [];
    const { p, items, more } = page(url, all);
    const declared = all.length + (FAULT === "wrong-total" ? 1 : 0) + (FAULT === "total-changes" && p === 2 ? 1 : 0);
    const out = items.map((it) => issueJson(key, it));
    if (FAULT === "no-node-id" && out.length) delete out[0].node_id;
    // empty-page: every page, the last real one included, points to a next page; the page after
    // the last real one is empty (and points on again).
    const next = more || FAULT === "empty-page";
    return json(res, 200, { total_count: declared, incomplete_results: FAULT === "incomplete", items: out }, next ? { link: linkTo(url, p + (FAULT === "skip-page" ? 2 : 1)) } : {});
  }
  if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})$/))) {
    const key = repoKey(m[1], m[2]);
    const known = key && world.repos[key].issues.some((i) => (i.pull_request?.commits ?? []).some((c) => c.sha === m[3]));
    return known ? json(res, 200, { sha: m[3] }) : json(res, 422, { message: "No commit found for SHA" });
  }
  // A repository's issue list (open, assigned to one login; pull requests included, as on GitHub).
  if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/))) {
    const key = repoKey(m[1], m[2]);
    if (!key) return json(res, 404, { message: "Not Found" });
    const who = url.searchParams.get("assignee");
    const all = world.repos[key].issues.filter((it) => (it.state ?? "open") === "open" && (it.assignees ?? []).includes(who));
    const { p, items, more } = page(url, all);
    return json(res, 200, items.map((it) => issueJson(key, it)), more ? { link: linkTo(url, p + 1) } : {});
  }
  if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
    const key = repoKey(m[1], m[2]);
    if (!key) return json(res, 404, { message: "Not Found" });
    return json(res, 200, { id: repoId(key), full_name: key, node_id: world.repos[key].node_id, private: false });
  }
  if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)(\/(comments|timeline|commits))?$/))) {
    const key = repoKey(m[1], m[2]);
    if (!key) return json(res, 404, { message: "Not Found" });
    const n = Number(m[4]);
    const it = world.repos[key].issues.find((i) => i.number === n);
    if (!it) {
      const moved = world.transfers?.[`${key}#${n}`];
      if (moved && !m[5]) {
        const [to, num] = moved.split("#");
        res.writeHead(301, { location: `${base}/repos/${to}/issues/${num}` });
        return res.end();
      }
      return json(res, 404, { message: "Not Found" });
    }
    if (FAULT === "offsite-redirect" && !m[5] && m[3] === "issues" && it.node_id === "I_pretend_web_1") {
      res.writeHead(301, { location: `http://localhost:${server.address().port}${path}` });
      return res.end();
    }
    if (!m[5]) {
      if (m[3] === "pulls") {
        if (!it.pull_request) return json(res, 404, { message: "Not Found" });
        return json(res, 200, { number: n, node_id: it.node_id, base: { repo: { full_name: FAULT === "pr-other-repo" ? "practice-owner/kettlebook-api" : key } }, state: it.state ?? "open", merged: it.pull_request.merged === true, merged_at: it.pull_request.merged_at ?? null, draft: false, body: it.body ?? "", commits: (it.pull_request.commits ?? []).length + (FAULT === "commit-gap" ? 1 : 0) });
      }
      const one = issueJson(key, it);
      if (FAULT === "token-in-body" && it.node_id === "I_pretend_web_1") one.body = `pasted by mistake: ${req.headers.authorization.slice(7)}`;
      if (FAULT === "assignee-no-id" && it.node_id === "I_pretend_web_1") delete one.assignees[0].id;
      return json(res, 200, one);
    }
    let list = m[6] === "comments"
      ? (it.comments ?? []).map((c) => ({ id: c.id, user: user(c.author), body: c.body, created_at: c.created_at, updated_at: c.created_at }))
      : m[6] === "timeline" ? (it.timeline ?? []) : (it.pull_request?.commits ?? []).map((c) => ({ sha: c.sha, commit: { message: c.message } }));
    if (it.node_id === "I_pretend_web_1" && FAULT === "comment-repeat" && m[6] === "comments") list = [list[0], list[0]];
    if (it.node_id === "I_pretend_web_1" && FAULT === "event-no-id" && m[6] === "timeline") list = list.map((e) => (e.event === "labeled" ? { ...e, id: undefined } : e));
    if (it.node_id === "I_pretend_web_1" && m[6] === "comments" && FAULT === "last-beyond") {
      const lastU = new URL(original);
      lastU.searchParams.set("page", "2");
      return json(res, 200, list, { link: `<${lastU.href}>; rel="last"` });
    }
    if (it.node_id === "I_pretend_web_1" && m[6] === "timeline" && FAULT === "full-page-no-next") {
      const p = Number(url.searchParams.get("page") ?? 1);
      const many = Array.from({ length: 101 }, (_, i) => ({ id: 80000 + i, event: "labeled", actor: { login: "practice-user" }, created_at: "2026-11-23T14:26:11Z", label: { name: `l${i}` } }));
      return json(res, 200, p === 1 ? many.slice(0, 100) : many.slice(100));
    }
    if (it.node_id === "I_pretend_web_1" && m[6] === "comments" && FAULT === "list-redirect") {
      res.writeHead(302, { location: original.href });
      return res.end();
    }
    if (it.node_id === "I_pretend_web_1" && m[6] === "comments" && ["next-other-list", "repositories-path", "link-unquoted", "link-garbled"].includes(FAULT)) {
      const p = Number(url.searchParams.get("page") ?? 1);
      if (p === 1) {
        const nx = new URL(original);
        nx.searchParams.set("page", "2");
        if (FAULT === "next-other-list") nx.pathname = nx.pathname.replace(/\/issues\/1\//, "/issues/2/");
        if (FAULT === "repositories-path") nx.pathname = `/repositories/${repoId(key)}/issues/1/comments`;
        const link = FAULT === "link-unquoted" ? `<${nx.href}>; rel=next` : FAULT === "link-garbled" ? `${nx.href} rel=next` : `<${nx.href}>; rel="next"`;
        return json(res, 200, list.slice(0, 1), { link });
      }
      return json(res, 200, list.slice(1));
    }
    const { p, items, more } = page(url, list);
    return json(res, 200, items, more ? { link: linkTo(url, p + 1) } : {});
  }
  return json(res, 404, { message: "Not Found" });
});
server.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`listening ${server.address().port}`);
});
