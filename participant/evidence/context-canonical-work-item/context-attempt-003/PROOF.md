# Proof · context-canonical-work-item

Attempt: `context-attempt-003`

Written by Tom Carter with Claude (Claude Code), 11-24-2026. The decisions are Tom's, from Tom's
answers to one question at a time; Claude wrote the model, the mappings, the code and this page.
**This quest's tools make no external reads or writes**: the normalization reads only the local
synchronized copies, and the records' script reads only local files and never needs the token. For
the identity check, Tom made the one change on GitHub (a rename and a move) by hand on GitHub's web
page, and then ran the GitHub quest's own read-only synchronization himself, as that quest's step;
this quest's script only read the result. The quest's own evidence asks for a real rename and move
followed by a re-synchronization, so one write and one read on GitHub can't be avoided; the write is
Tom's own edit, by hand, on his own practice repository, and the read is the earlier quest's tool.

**One earlier slip, stated plainly.** The first version of this quest's records' script (11-24-2026,
about 8:33 AM EST) made that rename and move itself, through Tom's `gh` login after a typed "yes": it
renamed the print-view issue and moved it from the web repository (#2) to the api repository (#5).
It also ran the GitHub quest's synchronization itself (23 read-only requests). Review round 1 caught
this as a breach of the safety constraint, and the script was rewritten to make no external reads or
writes. The synchronized copy still records that first move (web #2 → api #5), and the print-view
record keeps the api #5 node ID (`I_kwDOV40xIs8AAAABiGAaEA`) as an alias on purpose (identity must
remember every alias); the move
recorded in `logs/identity-check.txt` (api #5 → web #7, 11-24-2026 between 2:16 PM and 2:22 PM EST)
was made by Tom by hand, and the copy the final records rest on comes from Tom's own run of the
synchronization (11-24-2026 2:22 PM EST).

## What was built

One local work-item model for the two systems already synchronized in earlier quests, Jira (the
Jira quest's practice Jira) and GitHub (Tom's two public practice repositories), and a program that
applies it:

- **The model** (`participant/context/model/work-item.md`): non-goals first, then identity, every
  canonical field with its type, meaning and whether it is required, a closed set of four statuses,
  blocked as yes / no / unknown, what "open", "assigned to me" and "blocked" mean across systems,
  and which fields a next-work recommendation may rely on.
- **One mapping per system** (`participant/context/model/mappings/jira.md`, `github.md`): field by
  field, statuses with the lossy cases named, the source fields kept only in the source section,
  and the canonical fields the system can't supply.
- **The normalization** (`participant/tools/normalize-work-items.mjs`): reads the two synchronized
  copies (never the systems themselves) and writes one record per item
  (`participant/context/model/items/`), an index, `identity.json` (every alias each item has had)
  and the worked examples (`participant/context/model/examples.md`).
- **The records' script** (`participant/tools/model-record.sh`): the identity check and the
  unmappable check, written to this attempt's `logs/`.

## The hardest mapping decision (Tom)

**Blocked**, "because neither system tracks it the same way". Jira can record it (a flag, an "is
blocked by" link) but this copy has neither; GitHub has no blocked state at all; a team may use a
label nobody else uses. So blocked is **yes / no / unknown**, and "unknown" is never counted as
"not blocked". **What it costs:** today the honest answer to "which of my open work is blocked?" is
"none known to be blocked; all 3 can't say". **What it says about the teams:** blocking is mostly
recorded outside the tools (in stand-ups, chat, or a label one team made up), so each team means
something different by it; the model doesn't invent one meaning, and a team that agrees on one can
add it to its mapping.

Tom's first answer was a plain yes / no field; drafting the fields showed that neither source can
say "no", so Tom changed it to include "unknown" (otherwise the answer would have been "nothing is
blocked", an all-clear built on missing information).

## Choices (Tom's)

1. **Non-goals first** (all five kept): hierarchy, a ranking across systems, one person across
   systems ("matching names could link the wrong people"), effort, conversation history.
2. **Identity = system + the system's stable identifier.** GitHub: the **earliest node ID known**
   (the one already remembered, otherwise the first in the synchronization's record of its moves), later ones
   kept as aliases (GitHub gives a moved issue a new node ID). Jira: the **key stands in** for
   the numeric issue ID this copy doesn't hold, and the gap is named.
3. **Blocked = yes / no / unknown** (above).
4. **An open GitHub issue is always `todo`**; a linked pull request is advisory, never a status.
5. **The person's analysis lives in the same file**, after a "My analysis" line the normalization
   never changes.
6. **An item the model can't represent is refused on its own**: no record, reported with the
   reason, the other items written; an earlier record of it is kept and marked "not refreshed".
7. **The unmappable case uses a labelled test copy** of the Jira data.
8. **Stretch goal: a validation pass** before anything is written.
9. **Names:** Tom's GitHub login stays only inside repository addresses and links, where it is
   the owner of the public practice repositories, not a person in a role: provenance needs the
   address to be checkable. This was weighed against the quest's rule to redact personal names from
   shared examples: the login appears only as the owner part of an address, never as a person in a
   role. Wherever an account stands for a person (author, assignee, whoever an issue moved to) it is
   written "me (the signed-in account)", and anyone else "another account (name not carried)".
10. **The GitHub change for the identity check is made by hand** on GitHub's web page, and the
    GitHub quest's synchronization is run by Tom as that quest's step, so this quest's tools make no
    external calls (the safety constraint).

## What was tested or validated

Recorded on 11-24-2026 with Node 22.23.3. Criteria are referred to by number.

Both records were made with the final code, the identity check first and the unmappable check
after it; each log names the tools' SHA-256 (first 12 characters), the same in both:
`normalize-work-items.mjs f0f7296e0def`, `model-record.sh cb367ed72c7d`, `jira-sync.mjs
5d82dddb8f63`, `github-sync.mjs ebec844c807e`.

| Record | Made | SHA-256 of the log |
|---|---|---|
| `logs/identity-check.txt` | first half 11-24-2026 2:16 PM EST; second half 2:23 PM EST | `ea7b13619eb0adffda263f19c1e5117da6932af627c5a73b1c1c3666f7b0bfe4` |
| `logs/unmappable.txt` | 11-24-2026 2:23 PM EST | `351f96e3ab55496a4be3bb69db7bbb1b0ba60f2439a1c6e3146c4b0ccd6218d5` |

**The model document** (`work-item.md`). Criterion 1, verified: every canonical field has a type, a
meaning and "required: yes / no / when". Criterion 2, verified: identity is `<system>:<stable
identifier>`, "never comes from a file name, a title, a number or a local path"; a file is named
after the identity. Criterion 3, verified: five non-goals, each with its reason. Criterion 4,
verified: four statuses (`todo`, `in_progress`, `done`, `cancelled`); each mapping's status table
names its lossy cases (GitHub's open is always `todo`; "duplicate" and "not planned" both become
`cancelled`; a GitHub close with no reason and a Jira "Done" both read `done`). Criterion 12,
verified: "May rely on" and "Advisory only" lists, with `blocked: unknown` advisory.

**The mappings.** Criterion 6, verified: `mappings/jira.md` and `mappings/github.md` each map every
canonical field, list the source fields kept only in the source section, name the source fields not carried at
all, each with its reason, and end with "Canonical fields … can't supply here" (Jira: blocked, the
status value cancelled, closed time, delivery evidence, aliases, a non-key identifier; GitHub:
blocked, the status value in progress, type).

**The records.** Criterion 5, verified: each record has a source section titled
`source.jira.*` or `source.github.*`, holding priority, story points, repository, milestone, the
move history and the rest under the source's own names, separate from the canonical table.
Criterion 8, verified: each record's Provenance table has `source_system`, `source_id`,
`source_url`, `retrieved_at` and `sync_run`. Criterion 9, verified, with one honest qualification
first: the only Jira data that exists here is the Jira quest's (this quest's prerequisite), which
synchronizes the quest's practice Jira, so the Jira item is practice data synchronized by that
quest's real synchronization; the GitHub item is a real issue synchronized from GitHub.
`examples.md` sets Jira GTQ-101
beside GitHub's print-view issue, from the two synchronized copies (the Jira one made by the Jira
quest's synchronization from its practice Jira, the GitHub one from Tom's practice repositories),
and lists the differences kept: what identity means in each, "To Do" against open (GitHub can never
say `in_progress`), blocked `unknown` for both, a Jira closed time "not supplied" against
GitHub's "none" while open, and the source fields only one of them has.

**The identity check** (`logs/identity-check.txt`). Criterion 10, verified, in both systems; the
GitHub half is the primary evidence (a real issue, really renamed and moved), and the Jira half shows
the same mechanism on practice data:

- *Jira*: the Jira quest's own synchronization, against its practice Jira, in a throwaway folder,
  switching between two of its fixed practice data sets (the "rename" is the difference between
  them): first the one where GTQ-101 is "Fixture story GTQ-101" in To Do, then with the set
  where it is "Capture the intake conversation" in In Progress. The second normalization updated the
  same record (`jira:GTQ-101`, same file) to the new title and `in_progress`; there is one GTQ-101
  record, and its analysis note is byte-identical (SHA-256 `e98f262a…` before and after).
- *GitHub*: Tom renamed the open print-view issue and moved it to the other repository, by hand
  on GitHub's web page (api #5 renamed to "Print view for recipes and shopping lists (renamed for
  the identity check)" and transferred to the web repository), and ran the GitHub quest's
  synchronization (11-24-2026 2:22 PM EST; an earlier try stopped, writing nothing,
  because GitHub's search hadn't caught up). GitHub gave it a new number (web #7) and a **new node
  ID** (`I_kwDOV40wwM8AAAABiMSvpw`); the synchronization linked the two through GitHub's redirect.
  The normalization updated the same record (`github:I_kwDOV40wwM8AAAABhxgwfg`, same file) with the
  new title and address, added exactly the new node ID as an alias (aliases now
  `I_kwDOV40xIs8AAAABiGAaEA` and `I_kwDOV40wwM8AAAABiMSvpw`), made no second record (GitHub records:
  4 before and after), and left Tom's analysis note byte-identical (SHA-256 `c086faed…` before and
  after). Tom predicted beforehand "2 aliases, and the id stays the same"; both held.

**The unmappable check** (`logs/unmappable.txt`). Criterion 11, verified. A labelled test copy of
the Jira data (the real copy is only read) gives GTQ-102 the status "Waiting for Customer", adds
GTQ-150 with the same status and GTQ-151 with an empty summary. The run exits 2 and reports each
with its reason ("status "Waiting for Customer" isn't in the Jira mapping"; "required field missing
or not allowed: title"); GTQ-150 and GTQ-151 have no record at all; GTQ-102's earlier record is kept,
marked "Not refreshed" with the reason, its analysis note byte-identical; the other six items are
written; and the real model folder is unchanged. The validation pass (stretch goal) is what refused
GTQ-151.

**The person's analysis.** Criterion 7, verified: the synchronized source data lives in the Jira and
GitHub quests' folders and is only ever read; each canonical record holds a rendered view of it,
regenerated every run, and the person's analysis below one exact "My analysis" line. The separation
is enforced, not just drawn: the normalization never writes to the source copies; it keeps everything after that line as raw bytes and reads it back
after every write; it refuses any item whose generated part would contain a line that is, or looks
like, the analysis line; and it leaves a file whose line is missing or doubled untouched and reports
it. Re-normalization left the analysis unchanged in all three checks (SHA-256 before and after): the
Jira part of the identity check, the GitHub part (Tom's own note), and GTQ-102 in the unmappable
check.

**Reviews.** Copilot's practice review allowance is used up until December, so in its place (Tom's
decision) an extreme review: a deep self-review first, then independent reviewers working in
parallel, each given only the files and the quest's criteria: one trying to break the normalization
with crafted inputs, one on the records' script (token safety, honest checks, bash 3.2), one reading
everything as the grader would. Round 1 (sent 8:38 AM EST) found 3 High, 12 Medium and a number of Low
issues; each was reproduced before it was fixed, among them source text (a repository name, an
alias, a Jira field name) that could have broken out of a record's table, a character that could
stop every later run, notes not kept byte for byte when they weren't UTF-8, the script's GitHub calls
(replaced by Tom's change by hand), and checks that claimed more than they tested.

Ten rounds in all, each with three fresh reviewers, all on 11-24-2026 (times EST, when each round
was sent):

| Round | Sent | High | Medium |
|---|---|---|---|
| 1 | 8:38 AM | 3 | 12 |
| 2 | 8:59 AM | 3 | 9 |
| 3 | 9:08 AM | 0 | 7 |
| 4 | 9:16 AM | 1 | 6 |
| 5 | 9:26 AM | 0 | 9 |
| 6 | 9:37 AM | 0 | 4 |
| 7 | 9:46 AM | 0 | 5 |
| 8 | 9:58 AM | 0 | 5 |
| 9 | 10:06 AM | 0 | 5 |
| 10 | 10:17 AM | 0 | 1 |
| **All** | | **7** | **63** |

Every High and Medium was reproduced first and then fixed; the Lows were fixed too (their exact
number per round wasn't kept). Tom's stopping rule: stop when a round finds no High and no Medium in
the code. In round 10 the two code reviewers found nothing of Medium or High; the one Medium came
from the grader's reading (the index's summary of open work didn't count items not represented) and
was a one-line fix, so the rounds stopped at 10:27 AM EST. The final records were made after that,
with no code change since.

## Where the important artifacts are

- The model: `participant/context/model/work-item.md`
- The mappings: `participant/context/model/mappings/jira.md`, `participant/context/model/mappings/github.md`
- The worked examples: `participant/context/model/examples.md`
- The records: `participant/context/model/items/` (one per item, and `index.md`);
  `participant/context/model/identity.json`
- The normalization: `participant/tools/normalize-work-items.mjs`
- The checks: `participant/tools/model-record.sh`; their records:
  `participant/evidence/context-canonical-work-item/context-attempt-003/logs/identity-check.txt`
  and `logs/unmappable.txt`
- The inputs (read only): `participant/context/jira/assigned/stories.json`,
  `participant/context/github/assigned/sync-state.json`

## How to reproduce the behavior

From the repository's top folder:

```sh
node participant/tools/normalize-work-items.mjs
bash participant/tools/model-record.sh unmappable
```

The identity check comes in two halves around a change on GitHub that Tom makes by hand. The
evidence the quest asks for ("re-running normalization after a source item was renamed and moved")
needs a re-synchronization in between; that is the GitHub quest's own tool, run by Tom, while this
quest's script makes no GitHub calls and doesn't need the token:

```sh
bash participant/tools/model-record.sh identity        # part 1, the starting point, Tom's note
# rename and move the issue on GitHub's web page, then the GitHub quest's own synchronization,
# with the read-only token loaded (read -rs GTQ_GITHUB_TOKEN && export GTQ_GITHUB_TOKEN):
node participant/tools/github-sync.mjs
bash participant/tools/model-record.sh identity-after  # normalizes again and checks
```

## Remaining limitations

- **Two systems, practice data.** Trello isn't modelled (no practice board); its list position would
  stay in a `source.trello.*` section, under the ranking non-goal.
- **Jira identity is the key.** This copy has no numeric issue ID, so a story moved to another Jira
  project would get a new key and look like a new item. With real data, the numeric ID would be the
  identity and the key an address.
- **A GitHub move is linked only through the synchronization's record of GitHub's redirect.** If
  that history were lost (the synchronized copy started again from empty), a moved issue would get
  a new identity, though `identity.json` still remembers every alias it has seen.
- **Status is lossy where the sources are**: GitHub can't say "in progress", and this Jira copy
  doesn't carry the resolution behind "Done".
- **Blocked is `unknown` everywhere** until a source records it, or a team agrees a label and adds it
  to a mapping.
- **Files are switched one by one.** Each record is written whole and renamed into place, but a run
  stopped half-way leaves some records from the new run and some from the old; every record is
  regenerated from the sources, so the next run puts it right.
- **No duplicate detection across systems** (a stretch goal not chosen): the same work in Jira and
  GitHub would be two records.
- **A note saved in the instant a record is rewritten can be lost**: the analysis is read, then the
  file replaced; an editor's save between the two is overwritten. Close the editor, or save before
  running.
- **A work item titled "My analysis"** (or another line that looks like that heading, including
  full-width look-alikes) is refused rather than rendered, so the person's section can't be confused
  with it. Look-alikes built from other alphabets (a Cyrillic "М") aren't caught; they can't become
  the exact analysis line, but could confuse a reader.
- **Earlier quests' notes aren't carried.** The Jira quest's `notes/<KEY>.md` files and the GitHub
  copy's "My notes" sections belong to those quests; this model's analysis is each record's own "My
  analysis" section.

## Sensitive values

No secret, token, password, customer name or private ticket content is here. The Jira data is the
quest's made-up practice data (addresses under `example.invalid`); the GitHub data is real GitHub
issues with made-up content, in two public practice repositories under Tom's own account; that
account appears only inside repository addresses, and is written "me (the signed-in account)" where
it stands for a person. The token was made by Tom and lives only in Tom's
terminal; when it is loaded in the terminal running the records' script, that script refuses to
save a record that contains it and checks the files the runs wrote; the script also writes this
computer's folders as `<repo>`, `<temp>` or `~`. No raw API response is copied into the model or the
examples.
