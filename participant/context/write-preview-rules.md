# Write preview rules

The rules every write to the fake story tracker follows (`participant/tools/fake-story-tracker.py`).
They are the habit every later integration needs: show the change, wait for a person, then make
that change and no other. Decisions by Tom Carter; wording drafted with Claude (Claude Code),
10-29-2026.

## 1. What a preview must contain

A preview shows everything the write would do, before it does any of it:

- **The target:** which system and which project (here, the fake story tracker, project TIX).
- **The action:** what will happen (create), how many stories, and that it is all or none.
- **Every field of every story:** type, priority, title, the question it came from and the answer
  assumed, the description, and each acceptance criterion, in full.
- **The key each story will get** (TIX-1, TIX-2, ...), and how many stories the tracker has now.
- **The fingerprint** that a confirmation must quote, when the preview was made, and when it
  expires.
- **A plain statement that nothing was written**, with the tracker's count unchanged.

A preview writes no story. The only thing it saves is a record of itself, so a confirmation can be
checked against it later.

## 2. How a confirmation is tied to its preview

- The **fingerprint** is a code made from three things: the exact change (every field of every
  story, the target and the action), the tracker's contents when the preview was made, and the
  time it was made. Change any of them and the fingerprint changes.
- To confirm, a person runs `confirm` and **types the fingerprint** at the keyboard. An answer piped
  or redirected in is refused, and there is no option that skips the preview or the typing.
- Before writing, the tracker re-reads the stories file and checks that it still holds **exactly**
  the change that was previewed. If any field differs, the confirmation is refused, names what
  changed, and nothing is written. A change that doesn't alter any field (a comment, spacing) is
  not a different change.
- It also checks that the **tracker hasn't changed** since the preview, so the keys and the "all or
  none" promise still hold, and that the saved preview still matches its own fingerprint, so an
  edited preview record can't be confirmed.
- A preview approves **one write**. Once confirmed, the same fingerprint is refused, and stories
  that already exist can't be previewed again, so a second run duplicates nothing.
- Only **one run at a time** may check and change the tracker. If two people confirm at the same
  moment, the second waits, then sees the first one's write and is refused, so two confirmations
  can never both write or overwrite each other.
- The write needs a token from the environment (`FAKE_STORY_TRACKER_TOKEN`), read only at confirm.
  It is never printed, never stored and never part of a preview.

## 3. When a preview expires

- A preview can be confirmed for **15 minutes** after it was made: long enough to read three
  stories properly, short enough that a preview left open over lunch can't be approved later,
  when the person may no longer remember what it said.
- A confirmation more than 15 minutes after the preview is refused, says when the preview expired,
  and writes nothing. The person previews again and reads the change as it is now.
- The time limit is measured with the computer's own clock at the moment the fingerprint is
  typed, not when `confirm` was started, so leaving the prompt open doesn't stretch the limit; the
  confirmed time recorded on each story is that same moment. Only a preview can be
  dated earlier (`--made-at`, used to show expiry), which can only shorten its life, never extend
  it. It can't be dated in the future.

## 4. What a confirmed write records

Each story written records its key, every field, **who confirmed it**, **when**, and the
**fingerprint of the preview** it was confirmed under. `list` shows all of this, so anyone can see
what was written and that a person approved it.

## 5. When the tracker's own files can't be trusted

- The tracker's folders are opened **without following a link**. If the tracker folder, the
  folder that holds it, its previews folder or one of its files is a link to somewhere else, the
  run is refused and nothing is read or written through it, so a write can never land in some
  other place's files.
- Every stored story and every saved preview is checked to have exactly the shape it should. A
  damaged one is refused with a plain explanation, and nothing is written; the tool never stops
  with an error dump instead of saying what's wrong.
