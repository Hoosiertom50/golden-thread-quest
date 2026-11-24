# The canonical work-item model

Model version 1, 11-24-2026. Decided by Tom Carter, one question at a time; written by Claude
(Claude Code). Applied by `participant/tools/normalize-work-items.mjs` to the local copies made by
the Jira and GitHub synchronizations; per-system mappings are in `mappings/`, and two items side by
side in `examples.md`.

**What it is for:** answering, across every system, "which of my open work is blocked?", and
questions like it, from one local form, without pretending the systems agree where they don't.

## Non-goals: what the model deliberately does not represent

1. **Hierarchy.** Jira epics, parents and subtasks have no shared form (GitHub has none in this
   data). A Jira parent stays in Jira's own section; there is no canonical "parent" field (the
   advisory `related` list may mention it as text, nothing more).
2. **A ranking across systems.** Jira priority, GitHub's lack of one and Trello's list position
   can't be put on one scale honestly, so there is no canonical "priority".
3. **One person across systems.** A Jira account and a GitHub login are never matched to the same
   human: matching names could link the wrong people. "Assigned to me" is decided by each system's
   own signed-in account.
4. **Effort.** Story points (Jira's `customfield_10016`) have no GitHub counterpart and don't mean
   the same on every team; they stay in Jira's section.
5. **Conversation history.** Comments and events are long, change all the time and would turn every
   re-synchronization into noise in the records; the synchronized source copies already keep them.
   A record says how many there are and links to the item in its own system
   (`provenance.source_url`), where the conversation lives.

## Identity

**A canonical identity is the source system plus that system's own stable identifier**, written
`<system>:<identifier>`. It never comes from a file name, a title, a number or a local path; a
record's file is named after its identity, not the other way round.

- **GitHub:** `github:<node ID>`. GitHub gives an issue a **new node ID when it moves to another
  repository** (seen for real in the GitHub quest), so the identity is the **earliest node ID
  known** for the item: the one already remembered for it in `identity.json`, otherwise the first in
  the synchronization's record of its moves (`previous_node_ids`), otherwise its node ID; every later
  one is kept as an alias. Old and new are linked only through
  GitHub's own evidence: the synchronization's record of GitHub's redirect from the old address
  (`moved_from`, `previous_node_ids`). The number and repository are an address, not an identity.
- **Jira:** `jira:<key>`. Jira's stable identifier is its numeric issue ID; the practice copy holds
  only keys, so **the key stands in for it**. The gap is real: in a real Jira a key changes when a
  story moves to another project, and that move would look like a new item. With real data, the
  numeric ID would be the identity and the key an address.
- Once an identity is given, every alias is remembered (`identity.json`), so a later run that sees
  any of an item's identifiers finds the same record. An item whose identifiers point to two
  different records is not guessed between: it is reported and not written.

## Canonical fields

Types: *text* is untrusted source text, shown as text, never followed; *time* is the source's own
ISO-form timestamp, shown to people as MM-DD-YYYY with a 12-hour time in one fixed zone, US Eastern
(so a re-run on another computer shows the same times), with the source's form kept beside it in
brackets, so it can be checked. In a record, **"not supplied"** means the source has no way to give
that value, and **"none"** means the source gave it and it is empty (an open issue has no closing
time); a time that isn't a real calendar moment is
shown as "not a valid time".

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | text | yes | The canonical identity (above). |
| `aliases` | list of text | yes (may be empty) | Other identifiers the source has given this item. |
| `system` | `jira` \| `github` | yes | The source system. |
| `title` | text | yes | The item's current title (Jira summary, GitHub title). |
| `status` | `todo` \| `in_progress` \| `done` \| `cancelled` | yes | The closed set below. |
| `open` | yes \| no | yes | Derived: yes for `todo` and `in_progress`. |
| `blocked` | yes \| no \| unknown | yes | **unknown** when the source has no way to record blocking (below). Never "no" for "nobody knows". |
| `assigned_to_me` | yes \| no | yes | Yes only if the source's last complete synchronization returned it for its own signed-in account. |
| `assignment_note` | text | when `assigned_to_me` is no | Why it left (closed, unassigned, moved, no longer returned) and when that was noticed. |
| `status_as_of` | time | yes | When the source last confirmed this status. For an item no longer assigned, it can be older than the run. |
| `type` | text | no | The source's own kind of work (Jira issue type). This GitHub copy has none; labels aren't types. |
| `labels` | list of text | no | The source's labels, unchanged. |
| `created`, `updated`, `closed` | time | no | As the source gave them. |
| `related` | list of text | no | Other GitHub issues the source links to, as canonical ids when they are in this copy, otherwise as source addresses (or "another account's repository" when the address would carry someone else's name); a Jira parent is shown as its key. Advisory. |
| `delivery_evidence` | `exists` \| `partial` \| `missing` | no | GitHub only: pull requests and commits that say they deliver the item. Advisory. |
| `provenance` | group, every part required | yes | `source_system` (`jira` \| `github`); `source_id` (text: the identifier as the source gives it now); `source_url` (text: the item's own page in its system); `retrieved_at` (time: when the item itself was last fetched in full); `sync_run` (text: the synchronization run that produced the copy being read, its tool and time; for an item that left, it can be later than `retrieved_at`). |
| `model_version` | number | yes | The model version the record was written under. |

Everything else the source gives is either kept in the record's **source section**, under the
source's own names (`source.jira.*`, `source.github.*`), or listed in that system's mapping under
"not carried at all", with the reason; nothing is merged into a canonical name.

## Status: a small, closed set

| Canonical | Meaning |
|---|---|
| `todo` | Open, and the source doesn't say work has started. |
| `in_progress` | Open, and the source says work has started. |
| `done` | Closed as finished. |
| `cancelled` | Closed without being finished (not planned, duplicate, won't do). |

Each system's statuses are mapped in its mapping document, **with the lossy cases named**. A status
that isn't in a mapping is **not guessed**: the item is reported as not represented (below).

The main lossy cases: GitHub has no "in progress", so an open GitHub issue is always `todo`, even
while someone works on it (a linked pull request is advisory evidence, never a status); Jira's
"Done" doesn't carry its resolution in this copy, so a story closed as "won't do" under a Done
status would read `done`; GitHub's "duplicate" becomes `cancelled`, the reason kept in the source
section.

## Blocked

`yes` only when the source says so; `no` only when the source could say and doesn't; otherwise
`unknown`. Neither practice source records blocking: the Jira copy has no flag or "is blocked by"
link, and GitHub has no blocked state. So every item here is `unknown`, and the honest answer to
"what's blocked?" is "none known to be blocked; N items can't say".

## "Open", "assigned to me", "blocked": the question across systems

- **Open:** `status` is `todo` or `in_progress`.
- **Assigned to me:** the source's last complete synchronization returned the item for that
  source's own signed-in account (the normalization refuses a Jira copy whose run summary doesn't
  say it was complete; the GitHub synchronization writes nothing unless its run was complete). Items that left stay, with `assigned_to_me: no` and the reason.
- **Blocked:** as above; `unknown` is reported separately, never counted as not blocked.

## What a next-work recommendation may rely on

- **May rely on:** `id`, `system`, `title`, `status` and `open`, `assigned_to_me`, `blocked` when
  it is `yes` or `no`, `status_as_of` (to say how old the answer is), and `provenance.source_url`.
- **Advisory only** (may be mentioned, never decide anything): `blocked: unknown` (it means "can't
  say"), `labels`, `type`, `related`, `delivery_evidence`, `assignment_note`, `created`, `updated`,
  `closed`, and everything in a source section (Jira priority and story points, GitHub milestone).
- **Bookkeeping, not for deciding anything:** `aliases`, `model_version`, and the rest of
  `provenance` (`source_system`, `source_id`, `retrieved_at`, `sync_run`).
- Records marked "Not refreshed" aren't counted in "my open work"; the index lists them separately
  with how many there are.

## Records, and the person's analysis

One file per item, `items/<system>__<identifier>.md`, in four visibly separate parts: the
canonical fields, the source section, provenance, and **My analysis**. The synchronized source data
itself lives elsewhere (`participant/context/jira/assigned/`, `participant/context/github/assigned/`)
and is only ever read; a record's source section is a rendered view of it, regenerated every run.
The notes kept by the earlier quests (the Jira quest's `notes/<KEY>.md`, the GitHub copy's "My notes"
sections) stay where they are and aren't carried; this model's analysis is each record's own "My
analysis" section.
The person's analysis is kept apart from the synchronized source data (a different folder, never
written) and, inside the record, from the rendered view by an enforced boundary, not just a drawn
one: everything after the one exact "My analysis" line is the person's, kept as raw bytes
and read back after every record it writes; no generated line may be or look like that line (an item whose
source text would produce one is refused); a file with that line missing or doubled is left
untouched and reported. The synchronized source copies are only read, never changed.

## Not represented

An item the model can't represent (a status no mapping knows, a missing required field, identifiers
pointing to two records) is **refused on its own**: no record is written for it, it is listed under
"Not represented" in `items/index.md` with the reason, and the other items are written normally. If
it had a record from an earlier run, that record stays, marked **"not refreshed"** with the reason,
so nobody takes it for current (except a file whose "My analysis" line is missing or doubled: that
file is left untouched, unmarked, and listed under "Not represented", whether or not its item is in
the copies this run). The index's summary of my open work says how many records weren't refreshed
and how many items weren't represented, since any of them may be open work of mine. A record whose item no longer appears in either synchronized copy is
kept and marked the same way ("no longer in either synchronized copy"); the run then exits 2 until a
person decides what to do with it: to retire it, delete its file (its identity stays remembered in
`identity.json`, so the same item coming back gets the same record). Source text that is structured rather than plain (such as a Jira
Cloud description) is shown as "a structured value (not carried)", never as "none".

Before anything is written, a **validation pass** checks every required field taken from the source
(title, status, the assignment note when it left, status time, and the provenance) for an allowed
value; the fields the program sets itself (id, aliases, system, open, model version) are built only
from checked values. A record that fails is reported and not rendered. Source values that aren't
plain (objects inside fields) are written as "a structured value (not carried)", so nothing the model
doesn't define, such as another person's name, slips through; other people are written "another
account (name not carried)".
