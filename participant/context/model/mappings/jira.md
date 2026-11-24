# Mapping: Jira → canonical work item

Model version 1. Source: the Jira synchronization's local copy,
`participant/context/jira/assigned/stories.json` (made by `participant/tools/jira-sync.mjs` from the
quest's practice Jira; read only).

## Field by field

| Canonical | From Jira | Notes |
|---|---|---|
| `id` | `jira:` + `key` | The key stands in for Jira's numeric issue ID, which this copy doesn't hold (see the model's Identity section). |
| `aliases` | none | A real Jira would add the old key when a story moves project; this copy can't show that. |
| `system` | `jira` | |
| `model_version` | none | Set by the normalization (1). |
| `title` | `summary` | |
| `status` | `status` | Table below. |
| `open` | from `status` | |
| `blocked` | none | Always `unknown`: this copy has no flag and no issue links. |
| `assigned_to_me` | in `stories` → yes; in `removed` → no | Jira's own search for `currentUser()`, as the synchronization ran it. |
| `assignment_note` | `removed[].reason`, `removed_at` | Jira's copy doesn't say *why* a story left (closed, reassigned); it says it was no longer returned, or that it is assigned to another account (name not carried). |
| `status_as_of` | `retrieved_at` (for a removed story, its last-known record's `retrieved_at`) | |
| `type` | `type` | |
| `labels` | `labels` | |
| `created`, `updated` | `created`, `updated` | Jira's own form, `+0000` offset, kept as given. |
| `closed` | none | This copy has no resolution date. |
| `related` | `parent` (when set) | Hierarchy is a non-goal: the parent is shown as its key ("Jira parent KEY"), not modelled or resolved to a canonical id. |
| `delivery_evidence` | none | Jira's development panel isn't in this copy. |
| `provenance.source_system` | `jira` | |
| `provenance.source_id` | `key` | |
| `provenance.source_url` | `source_url` | Must be the story's own page (`…/browse/<key>`) on the Jira host the copy's stories use. |
| `provenance.retrieved_at` | `retrieved_at` | |
| `provenance.sync_run` | `jira-sync` + the copy's `synchronized_at` (and practice set) | The normalization refuses a copy whose run summary doesn't say the synchronization was complete. |

## Status

| Jira status | Canonical | Lossy? |
|---|---|---|
| To Do | `todo` | |
| In Progress | `in_progress` | |
| Done | `done` | Yes: the resolution (done, won't do, duplicate) isn't in this copy, so every Done reads `done`. |
| anything else | not represented | Refused with the reason; a team's own statuses ("In Review", "Waiting for Customer") need a decision first, added here. |

Real Jira groups every status into one of three categories (to do, in progress, done); a copy that
kept the category could map unknown status names by it. This copy keeps only the name.

## Jira fields kept only in the source section (`source.jira.*`)

`priority`, `status` (the Jira status name, as given), `assignee` (written "me (the signed-in
account)" when it is the synchronization's own account, otherwise "another account (name not
carried)": no other person's name or account ID is carried; for a story that left it is labelled
"assignee (last known)"), `description`, `acceptance_criteria`, `parent`, every field under
`jira_fields` (here `customfield_10016`, story points), and the **number** of comments only (the
comments themselves stay in the synchronized copy: conversation history is a non-goal).

## Jira fields not carried at all

The copy's top-level `account_id` (used only to recognise "me") and `synchronized_at` (used only in
`sync_run`); the removed list's `key`, `source_url`, `last_known_status` and `last_known_summary` (the
normalization reads the removed story's whole `last_known_record` instead); the comments' text,
authors and times; the assignee's name and account ID; the Jira quest's own `notes/<KEY>.md` files
(that quest's notes, not this model's analysis); and the run summary (`sync-summary.json`),
of which only `complete`, `retrieved_at` (it must match the copy's run) and `practice_set` are used.

## Canonical fields Jira can't supply here

`blocked` (always `unknown`), the `status` value `cancelled` (never: the resolution isn't in this
copy), `closed`, `delivery_evidence`, `aliases` (always empty here), and a stable non-key identifier.
