# Proof · jira-read-assigned-stories

Attempt: `jira-attempt-002`

Written by Tom Carter with Claude (Claude Code), 11-20-2026. The choices below are Tom's, from his
answers to one question at a time; Claude wrote the code and this page.

## What was built

A reusable, read-only synchronization of the stories assigned to the signed-in user into local,
normalized files, run only against a pretend Jira serving the quest's practice data.

- **The skill** (`participant/skills/jira-read-assigned/SKILL.md`): the workflow and its safety
  rules, reusable for any later synchronization.
- **The pretend Jira** (`participant/tools/fake-jira.mjs`, Tom's choice): it serves a practice
  data set (`validators/fixtures/jira/<name>.json`) the way Jira's REST API answers: `myself` for
  the signed-in user, a search returning one page at a time with `startAt`, `maxResults`, `total`
  and `isLast`, and comments paged the same way. The server sets the page size, as Jira does: the
  pagination set comes two stories a page. Every address uses `jira.example.invalid`.
- **The synchronization** (`participant/tools/jira-sync.mjs`), writing into
  `participant/context/jira/assigned/`: `stories.json` (the file the validator reads), `index.md`
  (a readable index) and `sync-summary.json` (what each run did: the stretch goal).
- **Notes kept apart** (Tom's choice): `notes/<KEY>.md`, one per story. The synchronization
  creates an empty one for a story it sees for the first time, with an exclusive create, and never
  opens an existing one for writing.

## Pagination, identity and merging

**Identity (criterion 1).** Every run first asks Jira who is signed in (`myself`) and keeps only
stories whose assignee is that account. No name or email address appears in the code. If Jira
doesn't say who is signed in, or a story's assignee is missing or has no account id (Jira sends
`null` only for an unassigned story), the run stops, rather than treating the story as someone
else's and moving it to `removed`.

**The query (criterion 2):** `assignee = currentUser() AND issuetype = Story ORDER BY key ASC`, so
stories assigned to the signed-in user; the work-item type is Story.

**Pagination (criterion 3).** The synchronization asks for the next page until Jira says the page
was the last (`isLast`), then checks that the stories received equal the `total` Jira reported and
that no key arrived twice. Every page must start where it was asked to, report the same total as
the first page, and say plainly (true or false) whether it is the last. If any of that fails, if a
page that isn't the last is empty, or if more arrive than the total, the run stops and writes
nothing (exit 1), so an incomplete list can never look complete. Comments are paged and counted
the same way, and every comment must have an id. Every story must have a Jira key (`ABC-123`,
because keys become notes file names), a summary and a status.

**Normalizing (criteria 4 and 5).** Each story has `key`, `source_url`, `summary`, `status`,
`priority`, `type`, `assignee`, `labels`, `description`, `acceptance_criteria`, `parent`,
`created`, `updated`, `retrieved_at` and `comments`. Fields only Jira has (here
`customfield_10016`) are kept under `jira_fields`, apart from the normal names.

**Merging (criteria 6 to 8).** Each run merges with the previous `stories.json` by key, never by
title:

- notes are never rewritten (criterion 6);
- comments are kept once per comment id, however often Jira returns them (criterion 7);
- a story no longer returned moves to `removed` with its last known status and summary, its
  source link, when it was removed and why; it is never deleted, and its notes file stays
  (criterion 8). A story that comes back leaves `removed`.

The three output files are published together: each is written whole to a new temporary name,
then each is renamed into place with the previous one kept aside; if any step fails, the previous
files are put back and the empty notes files that run created are removed, so the folder never
holds files from two different runs (tried separately by forcing the second rename to fail, and
by making the notes folder read-only: each time the folder came out byte-identical). Each
destination must be an ordinary file or not exist yet, checked before anything is written. The previous `stories.json` must look like this tool's own output (both
lists, Jira keys, no key twice) or the run stops and leaves it alone. The folders written into
must be ordinary folders, not links elsewhere: inside the repository, every folder from the
repository down to `notes`; outside it, the folder named and its `notes` folder. In `index.md`, ticket text is shown as plain
characters: every punctuation mark that Markdown or HTML could act on is escaped.

## What tells me the local copy is complete enough

Tom: **a notification from Jira itself that no other tickets were found**, not the
synchronization deciding on its own that it is done. In this synchronization that is Jira's
`isLast` on the final page, **and** the count adding up: the stories received must equal the total
Jira reported. If either is missing, the run writes nothing and the previous copy stays. Every run
records both in `sync-summary.json` (`pages_read`, `total_reported_by_jira`, `stories_received`,
`complete`), and the index states them in words ("Jira reported 2 stories and 2 arrived, so the
list is complete").

## Choices (Tom's)

1. **Practice data only;** nothing connects to a real Jira, so no real ticket or organization data
   can reach this public repository.
2. **Notes in separate files,** one per story, never written by the synchronization.
3. **A pretend Jira** that behaves like the real API, so identity and paging are shown working, not
   assumed.
4. **All four practice sets, each synchronized twice,** and checked by the app's validator; the
   repository keeps the stale-item result.
5. **One stretch goal:** the machine-readable run summary, `sync-summary.json`.

## Where the important artifacts are

All paths are under `participant/`.

- The skill: `skills/jira-read-assigned/SKILL.md`
- The synchronization: `tools/jira-sync.mjs`; the pretend Jira: `tools/fake-jira.mjs`
- The output (stale-item): `context/jira/assigned/stories.json`, `context/jira/assigned/index.md`,
  `context/jira/assigned/sync-summary.json`
- The notes: `context/jira/assigned/notes/`
- The demonstration: `tools/jira-sync-demo.sh`; its record:
  `evidence/jira-read-assigned-stories/jira-attempt-002/logs/sync-run.txt`
- The validator's results: `evidence/jira-read-assigned-stories/jira-attempt-002/validation/`

## How to reproduce the behavior

From the repository's top folder:

```sh
node participant/tools/jira-sync.mjs --fixture stale-item --phase previous
node participant/tools/jira-sync.mjs --fixture stale-item
.venv/bin/quest-app action run-validator --quest jira-read-assigned-stories \
  --validator validate-jira-read-assigned --param fixture_set=stale-item
bash participant/tools/jira-sync-demo.sh <a new logs folder>
```

## What was tested or validated

Recorded on 11-20-2026 at 12:18 PM with Node 22.23.3, at commit 69b2de0 with the quest's files
uncommitted (`logs/sync-run.txt`).

**Part A, in a temp folder: each practice set synchronized twice, with a person's note in place.**

- **Every set:** the second run finds no new or changed story, and every notes file is
  byte-identical across it (SHA-256 before and after); the list is complete (stories received
  equal Jira's total, on its last page).
- **happy-path:** 1 page, 3 stories.
- **pagination:** 2 pages, all 4 stories (GTQ-101, GTQ-102, GTQ-201, GTQ-202).
- **duplicate-comment:** GTQ-101's comments are 9001 and 9002, each once; 1 duplicate skipped.
- **stale-item:** run first in its previous state (GTQ-100 still assigned), then current: GTQ-100
  is listed under `removed` with its last known status, In Progress, and its notes file is kept.
- **The pretend Jira misbehaving, ten ways:** claiming more pages but sending an empty one;
  reporting 5 stories while sending 4; sending the first page again and again; a last page that
  reports a smaller total and leaves a story out; claiming more comments but sending an empty
  comment page; comments with no id; the key `../GTQ-101`, which tries to leave the notes folder;
  a story with no key; a story with no summary; and a story whose assignee has no account id.
  Each run stops with exit 1, its own message, and nothing written.
- **A summary full of Markdown and HTML** (a link, an image, a tag): the run succeeds and
  `index.md` shows every mark escaped, as typed.
- **Three previous `stories.json` files this tool didn't write** (`null`, `{}`, and the same key
  twice): each run stops with exit 2 and leaves that file exactly as it was.
- **A folder where `index.md` should be:** the run stops with exit 2; `stories.json`,
  `sync-summary.json` and the notes are unchanged.
- **A notes folder that is a link to another folder,** and **a copy of the repository whose
  `participant/context` folder is a link:** each run stops with exit 2 and nothing is written
  where the link points.

**Part B, in the real folder, run only when all of Part A came out as expected: the app's own
validator** (`validate-jira-read-assigned`, run with
`quest-app action run-validator`, network denied) after each set: **pass on all four**, every check
passing. It confirmed every story present (pagination), normalized fields, links to the source, no
duplicate records, no duplicate comments (duplicate-comment), the disappearance reported
(stale-item), and no raw responses committed. The notes files that existed before Part B are
byte-identical after it. Every folder from the repository down to the real notes folder must be
an ordinary folder, and the three generated files ordinary files; they are copied before Part B
and put back on any unsuccessful end (an unexpected result, a log that can't be written, or an
interruption), and any notes file Part B created that is still the empty one is removed; if
putting back fails, the copies are kept and named. Tried separately: with a stand-in validator
that always fails (in the real folder, and in a copy missing two notes files), each folder came
out byte-identical; interrupted during Part B, the real folder came out byte-identical; with
putting back made to fail, the copies were kept. The logs folder can't be inside the real output
folder. The repository keeps the
stale-item result: GTQ-101 and GTQ-102, with GTQ-100 under `removed`.

84 expectations in the record, all as expected.

## Remaining limitations

- **Practice data, not Jira.** The pretend Jira follows Jira's paging and identity answers, but a
  real connection would also need authentication (a token from the environment), rate limits and
  real field mappings, none of which the practice data exercises.
- **Acceptance criteria.** Jira has no field of its own for them; a project that keeps them in a
  custom field would map it to `acceptance_criteria`. None of the practice data has one, so it is
  always empty here.
- **Changes are found by comparing whole records.** Every run fetches everything; it doesn't yet
  fetch only what changed since the last run (delta synchronization was left as a stretch goal).
- **Notes from other practice sets stay.** Because notes are never deleted, the notes folder also
  holds the empty notes files created for the stories of the other three practice sets
  (GTQ-103, GTQ-201, GTQ-202).
- **Several validator results are kept.** The validation folder holds one result per validator
  run: two from the first checks, then four (one per practice set) for each run of the
  demonstration. All of them passed; the one that matches the record is the latest of each set.

## Sensitive values

No secret, token, password, customer name or real ticket content is here. All data is the quest's
practice data, the account is made up, every address uses `jira.example.invalid`, and no file shows
this computer's folders.
