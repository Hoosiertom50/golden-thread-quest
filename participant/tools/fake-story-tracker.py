#!/usr/bin/env python3
"""A fake story tracker, standing in for something like Jira, to show previewed and confirmed writes.

Part of the base-camp-write-preview quest (rules: participant/context/write-preview-rules.md).
Run from the repository root:

    .venv/bin/python participant/tools/fake-story-tracker.py preview --stories participant/context/write-preview/follow-up-stories.yaml
    .venv/bin/python participant/tools/fake-story-tracker.py confirm --stories participant/context/write-preview/follow-up-stories.yaml
    .venv/bin/python participant/tools/fake-story-tracker.py list

The "outside system" is a folder Git ignores, local-data/fake-story-tracker/. Nothing real is
touched. A write takes two separate runs:

  1. preview shows the target, the action and every field of every story that would be written,
     changes nothing and says so, and ends with a fingerprint: a code made from the exact change,
     the tracker as it is now, and the time the preview was made.
  2. confirm asks the person, at the keyboard, to type the fingerprint of the preview they approve.
     It writes only if that preview exists and hasn't been used, is no older than 15 minutes, the
     stories file still holds exactly the change that was previewed, and the tracker hasn't changed
     since. Otherwise it refuses, says why, and writes nothing. A written story records the
     fingerprint it was confirmed under, who confirmed it and when.

There is no option that skips the preview or the typed confirmation. The token the write needs
(FAKE_STORY_TRACKER_TOKEN) is read only by confirm, never printed and never stored.
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

import yaml

VERSION = "1.0.0"
DATA_DIR = Path("local-data/fake-story-tracker")
TIME_LIMIT = dt.timedelta(minutes=15)
TOKEN_VAR = "FAKE_STORY_TRACKER_TOKEN"

# The stories file holds exactly these keys, and every value is plain one-line text: anything else
# is reported, never guessed at.
TOP_KEYS = {"target", "action", "stories"}
TARGET_KEYS = {"system", "project"}
STORY_KEYS = {"from_question", "answer_assumed", "type", "priority", "title", "description",
              "acceptance_criteria"}
ACTIONS = ("create",)
TYPES = ("Story",)
PRIORITIES = ("Highest", "High", "Medium", "Low")
QUESTION_ID = re.compile(r"^Q-\d{2}$")
PROJECT = re.compile(r"^[A-Z]{2,10}$")
FINGERPRINT = re.compile(r"^[0-9A-F]{12}$")
MAX_STORIES = 20
MAX_TITLE = 120
WIDTH = 96


class Refused(Exception):
    """The run stops without writing anything; the message says why."""


class BadInput(Exception):
    """The stories file can't be read as a proposed change; the message says why."""


# --- time and display -----------------------------------------------------------------------------

def shown_time(moment: dt.datetime) -> str:
    """A time as people read it here: MM-DD-YYYY and a 12-hour clock, in local time."""
    local = moment.astimezone()
    return local.strftime("%m-%d-%Y %I:%M:%S %p ") + (local.tzname() or "")


def iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(text: str) -> dt.datetime:
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def grouped(fingerprint: str) -> str:
    """'7F3A91C20B4D' as '7F3A-91C2-0B4D', easier to read and type."""
    return "-".join(fingerprint[i:i + 4] for i in range(0, len(fingerprint), 4))


def actor() -> str:
    try:
        name = subprocess.run(["git", "config", "user.name"], capture_output=True, text=True,
                              timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        name = ""
    return name or getpass.getuser()


# --- the stories file -----------------------------------------------------------------------------

def plain(value: object, where: str, limit: int | None = None) -> str:
    """A field's value: one line of visible text."""
    if not isinstance(value, str):
        raise BadInput(f"{where} must be text")
    text = value.strip()
    if not text:
        raise BadInput(f"{where} is empty")
    if any(c in text for c in "\n\r\t") or any(not c.isprintable() for c in text):
        raise BadInput(f"{where} must be one line of visible text")
    if limit is not None and len(text) > limit:
        raise BadInput(f"{where} is {len(text)} characters; the limit is {limit}")
    return text


def exact_keys(mapping: object, keys: set[str], where: str) -> dict:
    if not isinstance(mapping, dict):
        raise BadInput(f"{where} must be a set of named fields")
    missing = sorted(keys - set(mapping))
    extra = sorted(set(mapping) - keys)
    if missing or extra:
        parts = ([f"missing {', '.join(missing)}"] if missing else []) + \
                ([f"unknown {', '.join(map(str, extra))}"] if extra else [])
        raise BadInput(f"{where}: {'; '.join(parts)}")
    return mapping


def load_change(path: Path) -> dict:
    """The proposed change in the stories file, checked and in a fixed form."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise BadInput(f"can't read {path}: {exc}") from exc
    try:
        # Every value is read as text, so YAML can't quietly turn one into a date, number or yes/no.
        raw = yaml.load(text, Loader=yaml.BaseLoader)
    except yaml.YAMLError as exc:
        raise BadInput(f"{path} isn't valid YAML: {exc}") from exc
    top = exact_keys(raw, TOP_KEYS, "the stories file")
    target = exact_keys(top["target"], TARGET_KEYS, "target")
    project = plain(target["project"], "target.project")
    if not PROJECT.match(project):
        raise BadInput("target.project must be 2 to 10 capital letters, like TIX")
    action = plain(top["action"], "action")
    if action not in ACTIONS:
        raise BadInput(f"action must be one of: {', '.join(ACTIONS)}")
    raw_stories = top["stories"]
    if not isinstance(raw_stories, list) or not raw_stories:
        raise BadInput("stories must be a list of at least one story")
    if len(raw_stories) > MAX_STORIES:
        raise BadInput(f"{len(raw_stories)} stories; one preview holds at most {MAX_STORIES}")
    stories, seen = [], set()
    for i, raw_story in enumerate(raw_stories, 1):
        where = f"story {i}"
        s = exact_keys(raw_story, STORY_KEYS, where)
        story = {k: plain(s[k], f"{where} {k}") for k in sorted(STORY_KEYS - {"acceptance_criteria"})}
        if not QUESTION_ID.match(story["from_question"]):
            raise BadInput(f"{where} from_question must look like Q-02")
        if story["from_question"] in seen:
            raise BadInput(f"{where} repeats {story['from_question']}; one story per question")
        seen.add(story["from_question"])
        if story["type"] not in TYPES:
            raise BadInput(f"{where} type must be one of: {', '.join(TYPES)}")
        if story["priority"] not in PRIORITIES:
            raise BadInput(f"{where} priority must be one of: {', '.join(PRIORITIES)}")
        if len(story["title"]) > MAX_TITLE:
            raise BadInput(f"{where} title is {len(story['title'])} characters; the limit is {MAX_TITLE}")
        criteria = s["acceptance_criteria"]
        if not isinstance(criteria, list) or not criteria:
            raise BadInput(f"{where} acceptance_criteria must be a list of at least one item")
        story["acceptance_criteria"] = [plain(c, f"{where} acceptance criterion {j}")
                                        for j, c in enumerate(criteria, 1)]
        stories.append(story)
    return {"target": {"system": plain(target["system"], "target.system"), "project": project},
            "action": action, "stories": stories}


# --- the simulated tracker ------------------------------------------------------------------------

def write_atomically(path: Path, text: str) -> None:
    """Writes the whole file or nothing; the temporary file is always removed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def load_tracker(data: Path) -> list[dict]:
    path = data / "stories.json"
    if not path.exists():
        return []
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Refused(f"the tracker file {path} can't be read ({exc}); nothing was written") from exc
    if not isinstance(items, list):
        raise Refused(f"the tracker file {path} isn't a list of stories; nothing was written")
    return items


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def tracker_state(items: list[dict]) -> str:
    """A short code for the tracker's whole contents: it changes if any story does."""
    return hashlib.sha256(canonical(items).encode("utf-8")).hexdigest()[:12].upper()


def make_fingerprint(change: dict, state: str, made_at: str) -> str:
    material = canonical({"change": change, "tracker_state": state, "made_at": made_at})
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:12].upper()


# --- the preview ----------------------------------------------------------------------------------

def wrapped(label: str, text: str, indent: int = 4) -> list[str]:
    first = " " * indent + f"{label:<13}"
    return textwrap.wrap(text, WIDTH, initial_indent=first, subsequent_indent=" " * len(first)) or [first]


def preview_lines(change: dict, items: list[dict], fingerprint: str, made: dt.datetime) -> list[str]:
    project = change["target"]["project"]
    count = len(change["stories"])
    next_number = len(items) + 1
    lines = [
        "PREVIEW: nothing has been written.",
        "",
        f"Target:   {change['target']['system']}, project {project}",
        f"Action:   {change['action']} {count} {'story' if count == 1 else 'stories'}, all or none",
        f"Tracker now: {len(items)} {'story' if len(items) == 1 else 'stories'}",
    ]
    for i, story in enumerate(change["stories"]):
        lines += ["", f"Story {i + 1} of {count}, to be created as {project}-{next_number + i}"]
        lines += wrapped("Type:", story["type"])
        lines += wrapped("Priority:", story["priority"])
        lines += wrapped("Title:", story["title"])
        lines += wrapped("From:", f"{story['from_question']} (answer assumed: {story['answer_assumed']})")
        lines += wrapped("Description:", story["description"])
        lines.append("    Acceptance criteria:")
        for j, criterion in enumerate(story["acceptance_criteria"], 1):
            lines += textwrap.wrap(criterion, WIDTH, initial_indent=f"      {j}. ",
                                   subsequent_indent=" " * 9)
    expires = made + TIME_LIMIT
    lines += [
        "",
        f"Preview fingerprint: {grouped(fingerprint)}",
        f"Made {shown_time(made)}; it can be confirmed until {shown_time(expires)} (15 minutes).",
        "To approve exactly this change, run confirm and type this fingerprint.",
        "",
        f"Nothing was written. The tracker still has {len(items)} "
        f"{'story' if len(items) == 1 else 'stories'}.",
    ]
    return lines


def do_preview(stories_file: Path, data: Path, now: dt.datetime,
               made_at: dt.datetime | None = None) -> tuple[list[str], str]:
    """Records a preview and returns what to show and its fingerprint. Writes no story."""
    change = load_change(stories_file)
    items = load_tracker(data)
    taken = {i.get("from_question") for i in items}
    already = [s["from_question"] for s in change["stories"] if s["from_question"] in taken]
    if already:
        raise Refused(f"the tracker already has stories for {', '.join(already)}; "
                      "nothing to preview and nothing was written")
    made = now if made_at is None else made_at
    if made > now:
        raise Refused("a preview can't be dated in the future; nothing was written")
    state = tracker_state(items)
    fingerprint = make_fingerprint(change, state, iso(made))
    record = {"fingerprint": fingerprint, "made_at": iso(made), "change": change,
              "tracker_state": state, "used": False}
    write_atomically(data / "previews" / f"{fingerprint}.json", json.dumps(record, indent=2) + "\n")
    lines = preview_lines(change, items, fingerprint, made)
    if made_at is not None:
        lines.insert(1, f"(Dated {shown_time(made)} with --made-at, earlier than now, to show expiry.)")
    return lines, fingerprint


# --- the confirmation -----------------------------------------------------------------------------

def differences(previewed: dict, current: dict) -> list[str]:
    """Plain words for how the stories file differs from what was previewed."""
    found = []
    for key in ("target", "action"):
        if previewed[key] != current[key]:
            found.append(f"the {key} changed")
    old, new = previewed["stories"], current["stories"]
    if len(old) != len(new):
        found.append(f"the preview had {len(old)} stories; the file now has {len(new)}")
    for i, (a, b) in enumerate(zip(old, new), 1):
        changed = sorted(k for k in a if a[k] != b.get(k))
        if changed:
            found.append(f"story {i}: {', '.join(changed)} changed")
    return found or ["the change differs from the preview"]


def do_confirm(stories_file: Path, data: Path, now: dt.datetime, typed: str, token: str | None,
               who: str) -> list[str]:
    """Writes the previewed stories if every check passes; otherwise raises Refused."""
    if not token:
        raise Refused(f"{TOKEN_VAR} isn't set, so the tracker can't be written to; nothing was written")
    entered = re.sub(r"[\s-]", "", typed).upper()
    if not FINGERPRINT.match(entered):
        raise Refused("that isn't a fingerprint (12 letters and digits, like 7F3A-91C2-0B4D); "
                      "nothing was written")
    path = data / "previews" / f"{entered}.json"
    if not path.exists():
        raise Refused(f"there is no preview with fingerprint {grouped(entered)}; nothing was written")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        made = parse_iso(record["made_at"])
    except (OSError, ValueError, KeyError) as exc:
        raise Refused(f"the preview {grouped(entered)} can't be read ({exc}); nothing was written") from exc
    # The record must still match its own fingerprint, so editing a saved preview (its time, its
    # stories or the tracker state it was made against) makes it useless rather than trusted.
    try:
        intact = make_fingerprint(record["change"], record["tracker_state"], record["made_at"]) == entered
    except (KeyError, TypeError):
        intact = False
    if not intact:
        raise Refused(f"the saved preview {grouped(entered)} has been altered since it was made; "
                      "nothing was written")
    if record.get("used"):
        raise Refused(f"preview {grouped(entered)} was already confirmed; a preview approves one "
                      "write only. Nothing was written")
    reasons = []
    if now - made > TIME_LIMIT:
        reasons.append(f"the preview expired at {shown_time(made + TIME_LIMIT)} "
                       f"(made {shown_time(made)}; the limit is 15 minutes)")
    current = load_change(stories_file)
    if current != record["change"]:
        reasons.append("the stories file no longer holds the change that was previewed: "
                       + "; ".join(differences(record["change"], current)))
    items = load_tracker(data)
    if tracker_state(items) != record["tracker_state"]:
        reasons.append("the tracker has changed since the preview was made")
    if reasons:
        raise Refused("Refused: " + " Also, ".join(r[0].upper() + r[1:] + "." for r in reasons)
                      + " Nothing was written; preview again to see the change as it is now.")
    # Every check passed: write all the stories at once, then mark the preview used.
    project = record["change"]["target"]["project"]
    written = []
    for i, story in enumerate(record["change"]["stories"], len(items) + 1):
        written.append({"key": f"{project}-{i}", **story, "confirmed_by": who,
                        "confirmed_at": iso(now), "preview_fingerprint": entered})
    write_atomically(data / "stories.json", json.dumps(items + written, indent=2) + "\n")
    record["used"] = True
    write_atomically(path, json.dumps(record, indent=2) + "\n")
    lines = [f"Confirmed by {who} at {shown_time(now)}, for preview {grouped(entered)}.", "Written:"]
    lines += [f"  {w['key']}  {w['priority']:<8} {w['title']}" for w in written]
    lines.append(f"The tracker now has {len(items) + len(written)} stories.")
    return lines


def list_lines(data: Path) -> list[str]:
    items = load_tracker(data)
    lines = [f"Tracker: {len(items)} {'story' if len(items) == 1 else 'stories'} "
             f"(tracker state {grouped(tracker_state(items))})"]
    for item in items:
        lines.append(f"  {item.get('key')}  {item.get('priority', '?'):<8} {item.get('title')}")
        lines.append(f"      from {item.get('from_question')}; confirmed by {item.get('confirmed_by')} at "
                     f"{shown_time(parse_iso(item['confirmed_at']))} under preview "
                     f"{grouped(item.get('preview_fingerprint', ''))}")
    return lines


# --- command line ---------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("preview", help="show the change and record a preview; writes no story")
    p.add_argument("--stories", type=Path, required=True)
    p.add_argument("--made-at", help="date the preview earlier than now (to show expiry), like "
                                     "2026-10-29T08:00:00-04:00; never later than now")
    c = sub.add_parser("confirm", help="type a preview's fingerprint to write exactly that change")
    c.add_argument("--stories", type=Path, required=True)
    sub.add_parser("list", help="show the stories in the tracker")
    args = ap.parse_args(argv)
    now = dt.datetime.now(dt.timezone.utc)
    print(f"# fake-story-tracker.py {VERSION} {args.command}")
    try:
        if args.command == "list":
            print("\n".join(list_lines(DATA_DIR)))
            return 0
        if args.command == "preview":
            made_at = None
            if args.made_at:
                try:
                    made_at = dt.datetime.fromisoformat(args.made_at)
                except ValueError:
                    raise BadInput("--made-at must be a date and time like 2026-10-29T08:00:00-04:00")
                if made_at.tzinfo is None:
                    raise BadInput("--made-at must include its time zone, like -04:00")
            lines, _ = do_preview(args.stories, DATA_DIR, now, made_at)
            print("\n".join(lines))
            return 0
        # confirm: the person types the fingerprint at the keyboard; piped-in answers are refused.
        if not sys.stdin.isatty():
            raise Refused("confirm needs a person at the keyboard; an answer piped or redirected in "
                          "is refused. Nothing was written")
        typed = input("Type the fingerprint of the preview you approve: ")
        print(f"You typed: {typed.strip()}")  # so the record shows what was approved
        print("\n".join(do_confirm(args.stories, DATA_DIR, now, typed, os.environ.get(TOKEN_VAR),
                                   actor())))
        return 0
    except BadInput as exc:
        print(f"Can't use the stories file: {exc}. Nothing was written.")
        return 2
    except Refused as exc:
        message = str(exc)
        print(message if message.startswith("Refused") else f"Refused: {message}.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
