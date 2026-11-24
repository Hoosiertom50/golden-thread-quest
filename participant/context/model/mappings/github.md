# Mapping: GitHub → canonical work item

Model version 1. Source: the GitHub synchronization's local copy,
`participant/context/github/assigned/sync-state.json` (made by `participant/tools/github-sync.mjs`
from the signed-in account's two public practice repositories; read only).

## Field by field

| Canonical | From GitHub | Notes |
|---|---|---|
| `id` | `github:` + the earliest node ID known | The identity already remembered for it in `identity.json`; otherwise `previous_node_ids[0]` when the issue has moved, otherwise `node_id`. |
| `aliases` | `previous_node_ids` and `node_id`, minus the identity, plus every alias already remembered in `identity.json` | A transfer gives a new node ID; the synchronization links each through GitHub's redirect (`moved_from`). |
| `system` | `github` | |
| `model_version` | none | Set by the normalization (1). |
| `title` | `title` | |
| `status` | `state` + `state_reason` | Table below. |
| `open` | from `status` | |
| `blocked` | none | Always `unknown`: GitHub has no blocked state. A team that agrees on a "blocked" label could map it; none is agreed here. |
| `assigned_to_me` | in `issues` → yes; in `no_longer_assigned` → no | The synchronization's search for the token's own login. |
| `assignment_note` | `no_longer_assigned[].reason` and `detected_at`; for "closed", the issue's own closing time and state reason | Closed, unassigned, transferred, inaccessible or out of scope. The synchronization's free-text `detail` is not carried (it can name whoever has the issue now): the note is built from these checked values, and "unassigned" reads "now assigned to another account (name not carried)" unless it is "no one". When the synchronization has seen the issue again since it left, the note reads "<reason> when noticed <time>; as of <time>: <state now>, <who has it now>", for example "still assigned to me on GitHub, but closed, so not in my open work". |
| `status_as_of` | `last_synced_at`; for an item no longer assigned, `state_seen_at` | `state_seen_at` is when GitHub last confirmed the state of an item that left; an item that left without one (transferred, inaccessible, out of scope) is as of its last full read, `last_synced_at`. |
| `type` | none | GitHub issues have no type here; labels such as "bug" stay labels. |
| `labels` | `labels` | |
| `created`, `updated`, `closed` | `created_at`, `updated_at`, `closed_at` | |
| `related` | `links` (issues only) | As canonical ids when the linked item is in this copy; otherwise as `owner/repo#N` when that repository is in the scope list or the signed-in account's, else "an issue in another account's repository (name not carried)". Advisory. |
| `delivery_evidence` | `delivery_evidence` | Advisory. |
| `provenance.source_system` | `github` | |
| `provenance.source_id` | `repository#number` and the current `node_id` | The address today, which changes on a move. |
| `provenance.source_url` | `url` | Must be exactly the issue's own page, `https://github.com/<repository>/issues/<number>`; anything else refuses the item. |
| `provenance.retrieved_at` | `last_synced_at` | |
| `provenance.sync_run` | `github-sync` + the copy's `synchronized_at` | The normalization refuses a copy whose `summary.complete` isn't true. The run that produced the copy being read. For an issue no longer assigned, that run can be later than its `retrieved_at` (the last time the issue itself was fetched in full), and its `status_as_of` sits between: when GitHub last confirmed its state. |

## Status

| GitHub state, state reason | Canonical | Lossy? |
|---|---|---|
| open (no reason, or `reopened`) | `todo` | Yes: GitHub has no "in progress"; an issue being worked on still reads `todo`. A linked open pull request is advisory delivery evidence, never a status. |
| closed, `completed` | `done` | |
| closed, `not_planned` | `cancelled` | |
| closed, `duplicate` | `cancelled` | Yes: "duplicate" and "not planned" become one value; the reason stays in the source section. |
| closed, no reason | `done` | Yes: GitHub treats a close without a reason as completed; older issues have none. |
| anything else | not represented | Refused with the reason. |

## GitHub fields kept only in the source section (`source.github.*`)

`repository`, `number`, `node_id`, `state`, `state_reason`, `author` and `assignees` (written "me
(the signed-in account)" for the synchronization's own account, "another account (name not
carried)" for anyone else; for an issue that left, "assignees (last known)"), `milestone` (its title
only), `body`, `moved_from`,
and linked pull requests (address, state, whether it says it closes the issue, and how many
commits). Comments and events stay in the synchronized copy (conversation history is a non-goal);
the source section says how many there are.

## GitHub fields not carried at all

Each issue's `file` (the GitHub copy's own file name), `previous_node_ids` (carried as aliases, not
as a source field), `links[].via`, `links[].kind` (used to sort links) and linked items' node IDs
(used to resolve `related`, not shown), pull requests' node IDs and their commits' hashes and
messages, the comments' and events' contents, each issue file's "My notes" section (the GitHub
quest's notes, not this model's analysis), the free-text `detail` of each `no_longer_assigned` entry,
the names of accounts other than the signed-in one
(written "another account"), the summary fields of each `no_longer_assigned` entry (`title`,
`repository`, `number`, `node_id`: the entry's whole `last_known_record` is read instead), and the
copy's top-level `tool`, `schema`, `identity` (its login is used only to recognise "me" and the
signed-in account's own repositories), `scope` (used only to decide which repository addresses may be
carried), `repositories` and `summary`.

## Which issues and addresses are carried

An issue is represented only if its repository is in the scope list (chosen by the person) or owned
by the signed-in account; any other is refused with that reason. Repository addresses found only in
links (a pull request or issue elsewhere that mentions this one, a move out of scope) are withheld
unless their repository qualifies the same way, because the owner part of such an address can be
another person's name.

## Canonical fields GitHub can't supply here

`blocked` (always `unknown`), the `status` value `in_progress` (never), and `type`.
