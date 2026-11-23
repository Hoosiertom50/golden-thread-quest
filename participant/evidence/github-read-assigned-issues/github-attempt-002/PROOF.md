# Proof · github-read-assigned-issues

Attempt: `github-attempt-002`

Written by Tom Carter with Claude (Claude Code), 11-23-2026; revised the same day after the review
(see "Revised after review" below). The choices below are Tom's, from
Tom's answers to one question at a time; Claude wrote the code and this page. Every GitHub write
(creating the practice repositories, and the changes between runs) was made by Tom, with Tom's own
login; the synchronization only reads.

## What was built

A reusable, read-only synchronization of the GitHub issues assigned to the signed-in user, across
the repositories in a scope list, run against two public practice repositories that Tom created and
filled with made-up issues about a made-up app.

- **The skill** (`participant/skills/github-read-assigned/SKILL.md`): the token, scope, query,
  paging, merging and safety rules, reusable for any later synchronization.
- **The synchronization** (`participant/tools/github-sync.mjs`), writing into
  `participant/context/github/assigned/`: one record per issue in `issues/` (with a **My notes**
  section the synchronization never changes), `index.md` grouped by repository,
  `delivery-links.md` (the stretch goal) and `sync-state.json`.
- **The scope list** (`participant/context/github/scope.json`): the two practice repositories and
  a third that doesn't exist, on purpose.
- **The practice data**, made by Tom with `participant/tools/github-practice-setup.sh`:
  `gtq-practice-kettlebook-web` (issues #1 and #2 assigned to Tom, #3 assigned to no one, and pull
  request #4 assigned to Tom, which says it fixes #1) and `gtq-practice-kettlebook-api` (issues #1
  to #3 assigned to Tom). Issue #1 exists in both. One comment holds an instruction addressed to an
  AI.
- **A pretend GitHub** (`participant/tools/fake-github.mjs`) that answers like GitHub's REST API
  and can misbehave on purpose, and **a checks script** (`participant/tools/github-sync-checks.sh`)
  that runs the synchronization against it: the cases real GitHub can't be made to produce.
- **A record script** (`participant/tools/github-sync-record.sh`) for the real runs: the token
  check, two consecutive runs with a note written between them, and a run after changes.

## Identity, scope and pull requests

**Identity (criterion 1).** Every run first asks GitHub whose token it holds (`GET /user`). No
login is written in the skill or the code; the run prints and records the login it was given
(`identity` in `sync-state.json`, and the first line of every run). The token is a fine-grained
personal access token Tom made for this quest, limited to the two practice repositories with
Contents, Issues and Pull requests read-only; it lives only in Tom's terminal
(`read -rs GTQ_GITHUB_TOKEN`), never in a file or on a command line. The GitHub CLI's own login
(which can write) is never used. A classic token with any scope other than `read:…` is refused, and
a folder holding another account's copy (by numeric id) is refused. The token check
(`logs/token-check.txt`, 12:12 PM) shows the token reads, and that GitHub refused one harmless write
for each of its three permissions with GitHub's own reason, "Resource not accessible by personal
access token" (another 403, such as a rate limit, wouldn't count).

**Scope (criterion 2).** The repositories in scope are listed in `scope.json`. Each is checked
first (`GET /repos/{owner}/{name}`); one that can't be read is reported with GitHub's answer (the
third, `gtq-practice-kettlebook-missing`, answers 404) in the run, in the index's Repositories
table and in `sync-state.json`, never left out silently.

**Pull requests (criterion 3).** GitHub's search covers issues and pull requests together. The quest
expects a mixed answer; GitHub today refuses a query that doesn't say which: the first real run
stopped with `Query must include 'is:issue' or 'is:pull-request'` and wrote nothing. So:

- the issue search asks for `assignee:<login> is:issue is:open repo:<owner>/<name>`;
- anything it still returns with a `pull_request` key is dropped and counted (a safety net, shown
  working against the pretend GitHub, which can return a pull request in the issue search the way
  GitHub's search once did);
- a separate `is:pull-request` search lists the assigned pull requests, so the record shows pull
  request #4 being left out rather than never seen;
- and both searches are checked against GitHub's own list of the repository's open issues assigned
  to the login (`/repos/{repo}/issues?assignee=…`, where a pull request carries a `pull_request`
  key): its issues must match the issue search and its pull requests the pull request search.

## Paging and the records

**Paging (criterion 4).** The search is followed page by page until GitHub sends no
`rel="next"` link; the items received must equal the `total_count` GitHub declared, the total must
be the same on every page, `incomplete_results` must be false, no page before the last may be
empty, no item may arrive twice, and each `next` link must ask for exactly the following page of
the same list. If any of that fails, the run stops and writes nothing (exit 1). The search index
can also miss a new issue in its items and its total alike, which is why the issue list above is
compared too. The final real runs used pages of 1, so a repository with two issues comes over two
pages (real use: 100). Comments and timelines are
paged the same way, and an issue's comments must add up to GitHub's own comment count; a list
page with no `next` link is the end only if no `last` link names a later page, and a full last page
is checked by asking for the following one, which must be empty.

**The records (criterion 5).** Each issue's record has its repository full name, number, node ID,
title, state, state reason (its own row, "none given" while GitHub gives none), author, assignees,
labels, milestone, body, created, updated and closed times. When an issue leaves because it was
closed or unassigned, its last known record is brought up to what GitHub said at that moment:
closed, with its state reason and closing time. The direct read of each issue decides (the search index can lag), and must answer for the
same address; a malformed answer (a missing body or author field, an assignee without an id, a
time that isn't GitHub's ISO form) stops the run rather than being filled in.

**Identity of an issue (criterion 6).** The key is the node ID; the file name is the repository
full name plus the number (`Hoosiertom50__gtq-practice-kettlebook-web__1.md`), so web #1 and api #1
are two records and two files.

**Comments and events (criterion 7).** Comments are kept once per comment id, with author and time;
material timeline events (assigned, labeled, renamed, closed, cross-referenced, commit references
and the like) once each, with who and when; a comment or event that arrives twice in one answer
stops the run. A comment no longer on GitHub stays, marked. **A transfer also reissues comment ids**
(seen for real on every move: 7104002453, then 7104734147, 7108370263 and 7109588488); the comments
of a moved issue are matched one to one by author, time and text, the old ids kept as
`previous_ids`, so web #6's record shows its one comment once.

**Links (criterion 8).** Pull requests and issues that cross-reference an issue, commits that
reference it, and `owner/repo#N` written in the text (GitHub records a link only to an issue that
already existed: web #2 mentions api #1, created after it). For a linked pull request in scope:
its state, whether it was merged, whether it says it closes the issue, and its commits (which must
add up to the pull request's own count); a commit counts as evidence only once GitHub confirms it
exists. Web #1's record shows pull request #4, open, "says it closes this issue", with its commit,
so its delivery evidence is partial.

**Notes (criterion 9).** Everything after the notes line in an issue's file is Tom's. Each run
keeps it byte for byte, checks it afterwards, and stops rather than write a file whose notes line
is missing or doubled; while holding the lock it re-reads every issue file, so a note being typed
during a run is never lost.

**Disappearances (criterion 10).** Only open issues count as assigned work (Tom's choice). An issue
assigned last time and not now is looked up at its old address to learn why (closed, unassigned,
transferred out of scope, or inaccessible) and listed under "No longer assigned" with the reason
and its whole last known record; its file and notes stay. **A moved issue gets a new node ID**
(seen for real: api #2 was `I_kwDOV40xIs8AAAABhxg5-w`, then web #5 was `I_kwDOV40wwM8AAAABhyDhOQ`;
Tom had predicted it would keep the same one), but its old address redirects (301) to the new one.
The synchronization counts a move only when GitHub really redirected there, records the issue as
moved with its earlier IDs, and moves Tom's notes into the new file. The final run moved it again,
web #5 → api #4, with Tom's note ("Ask the API team whether 10 exports an hour is enough.")
following it byte for byte (Tom predicted this one right), and then once more, api #4 → web #6,
the note following again.

**Times (criterion 11).** Per repository, `last_successful_sync` (kept from before for one that
couldn't be read); per issue, `last_synced_at`. Both are in `sync-state.json`, and shown in the
index and each record.

**Writing.** One run at a time (`.github-sync.lock`); every file is written whole to a temporary
name, checked, and renamed into place, with the previous ones put back on any error; a file saved
by someone while the run was writing is put back, or kept aside as `<file>.<pid>.saved`, never
overwritten; files a person wrote are never replaced; no file is written if any would contain the
token.

## Revised after review

The first review asked for three changes:

1. **State reason, and closed issues still shown as open.** Every record now has a State reason row,
   and the record of an issue that left because it was closed (or unassigned) shows GitHub's state
   at that moment, its reason and its closing time, instead of the open state it last had while
   assigned. Issues archived before the fix are brought up to date the same way: every run already
   looks each archived issue up at its old address, and now refreshes its state from that answer.
2. **One page per repository in the real runs.** The runs are recorded again with pages of 1, so a
   repository with two issues comes over two pages, each followed by its next link and the end
   confirmed.
3. **The evidence folder's name.** The quest text names `attempt-001`; the quest app created this
   attempt as `github-attempt-002` when the quest was started, and its evidence page resolves every
   required proof path into this folder (each shown as detected). The files are where the app
   looks for them.

Recorded again after the fixes, at 4:07 to 4:08 PM (details under "What was tested or validated"):
web's 2 open issues arrived over 2 pages of 1, each page followed by its next link and the end
confirmed; Tom then closed web #6 as not planned, and its record shows "State: closed", "State
reason: not\_planned" and "Closed: 11-23-2026 4:07 PM". The two issues closed earlier in the day
(api #1, not planned; web #1, completed) were refreshed the same way on the first run after the fix,
and their records now show closed, their reasons and closing times instead of "open". The fixes
were checked by a deep self-review (the Copilot practice review allowance was used up until
December), and the pretend GitHub checks gained six expectations for them.

## What tells me "assigned to me" is still true

Tom: the last synchronization time, for each issue and for each repository. In this copy that is
`last_synced_at` on every issue and `last_successful_sync` on every repository (both in
`sync-state.json`, shown in each record and in the index). A time only means something with the
run behind it, so the index also says, per repository, whether that run was complete (issues
declared and received, and the issue list agreeing), and which repositories couldn't be read and
since when; an issue that stops being assigned moves to "No longer assigned" with the reason,
rather than staying listed as current.

## Choices (Tom's)

1. **GitHub** as the second system for later quests (Trello has no practice data).
2. **Two small public practice repositories** of made-up issues, plus a repository that doesn't
   exist, so nothing real or private is read.
3. **A new read-only token** limited to the two repositories, made by Tom, never seen by Claude.
4. **Tom makes every GitHub write**, with Tom's own login; the synchronization only reads.
5. **Stretch goal: delivery evidence** per issue (exists, partial or missing).
6. **Open issues only** count as assigned; anything that leaves is kept with why it left.
7. **Notes in each issue's own file**, in a section the synchronization never changes.
8. **The node ID** as each issue's identity, with GitHub's forwarding linking a moved issue.

## Where the important artifacts are

All paths are under `participant/`.

- The skill: `skills/github-read-assigned/SKILL.md`
- The synchronization: `tools/github-sync.mjs`; the scope list: `context/github/scope.json`
- The output: `context/github/assigned/` (`index.md`, `issues/`, `delivery-links.md`,
  `sync-state.json`)
- The real runs' records: `evidence/github-read-assigned-issues/github-attempt-002/logs/`
  (`token-check.txt`, `second-run.txt`, `disappearance.txt`)
- The pretend GitHub and its checks: `tools/fake-github.mjs`, `tools/github-sync-checks.sh`; their
  record: `logs/pretend-github-checks.txt`
- Practice setup and changes (run by Tom): `tools/github-practice-setup.sh`,
  `tools/github-practice-changes.sh`

## How to reproduce the behavior

With a read-only token loaded (`read -rs GTQ_GITHUB_TOKEN && export GTQ_GITHUB_TOKEN`), from the
repository's top folder:

```sh
node participant/tools/github-sync.mjs --per-page 1
bash participant/tools/github-sync-record.sh token-check
bash participant/tools/github-sync-record.sh two-runs
bash participant/tools/github-sync-record.sh disappearance
```

Without a token (pretend GitHub, throwaway folder):

```sh
bash participant/tools/github-sync-checks.sh <a new logs folder>
```

## What was tested or validated

The records were made on 11-23-2026 with Node 22.23.3, starting from an empty output folder (Tom's
choice), after a rehearsal earlier that morning whose records were set aside. The token check is
from commit 90ed558; the run records are from commit a39f9ab, with the review fixes uncommitted.
Criteria are referred to by number.

**Token check (`logs/token-check.txt`, 12:12 PM).** The token belongs to Hoosiertom50 and reads
issue #1 (200). Creating a label, setting pull request #4's title to its own title, and creating a
file were each answered 403, "Resource not accessible by personal access token" (criteria 1 and 12).

The runs went in three sets, each continuing from the state the last one left: from the empty
folder at 12:12 to 12:15 PM; again at 1:02 to 1:03 PM, after one phrase of the run report was
reworded (it put a colon after the word for the credential, which the quest app's secret scan
rightly reads as a credential being shown); and after the review's fixes, at 4:07 to 4:08 PM, with
pages of 1. The token check is from the first set; the run records are from the third. The earlier
sets' changes are what the kept state still shows: at 12:14 PM Tom unassigned web #2, closed api #1
as not planned and moved web #5 to api #4 (the note following); at 1:03 PM Tom closed web #1 as
completed, assigned web #2 to Tom again and moved api #4 to web #6 (the note following again).

**Two consecutive runs (`logs/second-run.txt`, 4:07 PM).** Criterion 4, verified: GitHub declared
2 open issues assigned to Hoosiertom50, both in web (#2 and #6), and api none; with pages of 1, web's
2 arrived over 2 pages, followed by the first page's next link, and with api's one empty page that
is 3 pages in all. The issue list agreed, every list's end was confirmed by asking for the following
page, and the list is complete. Pull request #4 was found by the separate search and left out (criterion 3), and
`gtq-practice-kettlebook-missing` was reported unreadable, 404 (criterion 2). Criterion 9,
verified: run 2 added, changed, moved and removed nothing, and every notes section, Tom's note
included ("Ask the API team whether 10 exports an hour is enough.", now on web #6), has the same
SHA-256 of its exact bytes before and after, compared issue by issue. Criterion 7, verified: the
second run added no comment, event or record a second time.

**After changes on GitHub (`logs/disappearance.txt`, 4:08 PM).** Tom closed web #6 as not planned
at 4:07 PM. Criterion 10, verified: web #6 is listed under "No longer assigned" as "closed: closed
11-23-2026 4:07 PM (not\_planned)", its record showing State closed, State reason not\_planned and
its closing time, its file and Tom's note kept, same SHA-256; api #1 ("closed (not\_planned)",
12:14 PM) and web #1 ("closed (completed)", 1:03 PM) stay listed with their last known records.
GitHub declared 1 and sent 1, and every request was a GET (21). The moves are recorded in the earlier
sets and kept in `sync-state.json`: web #5 → api #4 (12:15 PM) and api #4 → web #6 (1:03 PM), each
linked by GitHub's redirect though the node ID changed, Tom's note following each time.

**The records.** Criterion 5, verified: each issue file and `sync-state.json` hold the repository,
number, node ID, title, state and reason, author, assignees, labels, milestone, body and the
created, updated and closed times. Criterion 6, verified: web #1 and api #1 are two records and two
files, keyed by node ID. Criterion 8, verified: web #1's record links pull request #4 (open, "says it closes
this issue") with its commit and api #1 by cross-reference, while api #1 links web #1 written in
its text (each with its node ID); `delivery-links.md` gives
each issue exists, partial or missing. Criterion 11, verified: `last_successful_sync` per repository
and `last_synced_at` per issue, in `sync-state.json` and the index.

**The pretend GitHub (`logs/pretend-github-checks.txt`, 4:08 PM): 196 expectations, all as
expected,** in a throwaway folder with no token or network. They cover what real GitHub can't be
made to do on demand: two runs with notes (one without a final line break); moves with the node ID
kept and changed, comment and event ids reissued, and both of GitHub's redirect forms (and a
redirect naming another repository's id, refused); 27 ways for GitHub to misbehave (wrong totals,
skipped or foreign pages, a list that goes on after its apparent end, unreadable or contradictory
Link headers, redirects on list requests, a "slow down" answer, text that isn't valid UTF-8,
missing fields, a repeated comment, a pull request from another repository, the search missing an
issue, a token with more than read scopes, the token echoed back or pasted into an issue), each
stopping the run with nothing written and the token never printed; untrusted Markdown and HTML
shown as text, including a body holding the notes line itself; local refusals (a person's
`index.md`, a lost notes line, another run's lock or leftovers, another account's folder, a notes
section that isn't UTF-8, a linked folder, a real token sent to the pretend server); and a note
saved while files were being swapped, kept (TEST ONLY copies of the tool make the save at that
moment); and the review's fixes (a State reason row on every record, a closed issue's record
showing closed with its reason and closing time, and an issue archived before the fix brought up
to date on the next run).

**Reviews.** A deep self-review before every round, then Copilot review rounds on a practice pull
request until a round reported no open issue (the eleventh); every finding was reproduced or
reasoned through first, fixed, or answered with the reason it is a limitation below. A last round,
on the final records, raised six more corner cases, listed under the limitations. The fixes after the first review were
checked by a deep self-review instead, Copilot's practice allowance being used up; it found one
more gap (an issue archived before the fix kept its old "open" record) and that was fixed too.

## Remaining limitations

- **Two practice repositories, made-up issues.** A real scope would be larger (search is limited to
  1,000 results per repository query, and the run stops rather than go past it) and would need rate
  limits respected over many requests (each archived issue is looked up on every run).
- **Search can lag.** Right after a change GitHub's search briefly didn't add up (declared 2, sent
  1, in the rehearsal, and again after a later change, checked before the next run); the run stops
  and writes nothing, and a run a minute later succeeds.
- **Checks aren't read.** The token has no permission for them; delivery evidence comes from pull
  requests and commits only.
- **A moved issue is linked only through GitHub's forwarding** from the old address the last run
  recorded; one moved out of the scope is reported as transferred and not followed further.
- **Files are switched one by one, and folders are checked, not held.** Node has no call that swaps
  several files at once or writes through a held folder, so a run killed between two renames leaves
  a mix of two runs, and a folder swapped for a link, or an editor's replace-style save, in the
  instant between a check and a write isn't caught. What a run leaves is named, the lock is kept
  and the next run refuses until a person has looked; recovery is that person's job.
- **Uncertain matches are kept, not guessed.** After a move, an old comment that can't be matched
  one to one (two comments by one person in the same second, one of them edited) is kept marked as
  no longer on GitHub rather than merged.
- **Found in the last review round and left open (Tom's decision, to hand in today).** The final
  practice review raised six more cases; none is in the practice data, and fixing any would mean
  recording the real runs again. (1) GitHub can signal a secondary rate limit with only a message,
  no `Retry-After`: a repository read that way would be reported unreadable for that run and its
  issues listed as inaccessible until the next run, nothing deleted. (2) A repository answer naming
  a different repository without a redirect is accepted. (3) An answer that omits the milestone
  field is read as "no milestone". (4) A comment's own `issue_url` isn't checked against the issue
  it was listed under. (5) The page asked for after a list's end is checked for a `next` link but
  not a `last` link. (6) The record and checks scripts remove a leftover temporary file of the same
  name even if another run made it. Each would be the next fix.
- **Every run reads everything.** It doesn't yet fetch only what changed since the last run (delta
  synchronization, a separate quest).

## Sensitive values

No secret, token, password, customer name or private ticket content is here. The repositories are
public and hold only made-up issues about a made-up app; the one account named is the practice
account that owns them. The token was made by Tom and lives only in Tom's terminal; the
synchronization removes its value from every message and refuses to write a file containing it,
and each run record was checked for it before it was kept. No raw API response is saved, and no
file shows this computer's folders (they are written as `<repo>`, `<temp>` or `~`).
