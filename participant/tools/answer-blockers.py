#!/usr/bin/env python3
"""Answers "What is blocking the release?" from saved notes, and says how old they are.

Part of the context-staleness quest. The rules are in participant/context/freshness/policy.md:
  - a note's age is the clock time minus the note's retrieval time;
  - up to its source's limit it is fresh; past the limit, up to twice the limit, it is stale;
    past twice the limit it is too old; a note with no retrieval time is too old;
  - the answer takes the worst status of any note: too old -> refuse, stale -> warn.
Every answer shows the clock used and the oldest note with its age, and a warned or refused
answer names each stale or too-old note and which notes to refresh.

The clock is never read from the computer: it must be given with --now, so the same notes and
the same clock always produce the same answer. Read-only: it writes nothing.

    .venv/bin/python participant/tools/answer-blockers.py \\
        --context participant/context/freshness/tixly-context.yaml --now "2026-10-21T15:00:00-04:00"
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

import yaml

VERSION = "1.1.0"
RANK = {"fresh": 0, "stale": 1, "too old": 2}


class StrictLoader(yaml.SafeLoader):
    """yaml's safe loader, but a key repeated in the same place is an error, not silently replaced.

    Plain YAML keeps the last of two `notes:` lists, so a first list holding stale or undated notes
    would vanish and the answer could look all fresh.
    """

    def construct_mapping(self, node, deep=False):
        seen = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in seen:
                raise yaml.constructor.ConstructorError(
                    None, None, f"the key '{key}' appears twice", key_node.start_mark)
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


def load_context(path: Path) -> dict:
    """The notes file, or an error message saying why it can't be used."""
    try:
        data = yaml.load(path.read_text(encoding="utf-8"), Loader=StrictLoader)  # noqa: S506 -- a SafeLoader subclass
    except (OSError, UnicodeDecodeError) as e:
        raise ValueError(f"{path} can't be read: {e}") from None
    except yaml.YAMLError as e:
        raise ValueError(f"{path} is not valid: {e}".replace("\n", " ")) from None
    if not isinstance(data, dict) or not isinstance(data.get("limits_days"), dict) or not isinstance(data.get("notes"), list):
        raise ValueError(f"{path} must have a 'limits_days' table and a 'notes' list")
    if not all(isinstance(n, dict) and n.get("id") and n.get("source") for n in data["notes"]):
        raise ValueError(f"{path}: every note needs an 'id' and a 'source'")
    return data


def parse_time(value: object) -> dt.datetime | None:
    """A time with its time zone, or None if it is missing or can't be read.

    Accepts the time written in quotes (text) or without (YAML reads it as a date and time).
    """
    if isinstance(value, dt.datetime):
        t = value
    elif isinstance(value, str):
        try:
            t = dt.datetime.fromisoformat(value)
        except ValueError:
            return None
    else:
        return None
    return t if t.tzinfo else None  # without a time zone the age would be a guess


def shown(t: dt.datetime) -> str:
    """MM-DD-YYYY, 12-hour time."""
    return t.strftime("%m-%d-%Y %I:%M %p").replace(" 0", " ", 1) + t.strftime(" (UTC%z)")


def age_text(delta: dt.timedelta) -> str:
    hours = int(delta.total_seconds() // 3600)
    days, hours = divmod(hours, 24)
    parts = []
    if days:
        parts.append(f"{days} day{'s' if days != 1 else ''}")
    if hours or not days:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    return " ".join(parts)


def assess(note: dict, limits: dict, now: dt.datetime) -> dict:
    """The note's age and status under the policy."""
    limit = limits.get(note.get("source"))
    retrieved = parse_time(note.get("retrieved_at"))
    if limit is None:
        return {"note": note, "age": None, "limit": None, "status": "too old",
                "why": f"no freshness limit for source '{note.get('source')}'"}
    if retrieved is None:
        return {"note": note, "age": None, "limit": limit, "status": "too old",
                "why": "no usable retrieval time (missing, unreadable, or without a time zone), so its age is unknown"}
    age = now - retrieved
    if age < dt.timedelta(0):
        return {"note": note, "age": age, "limit": limit, "status": "too old",
                "why": "retrieved after the clock time, so the clock or the note is wrong"}
    limit_td = dt.timedelta(days=limit)
    status = "fresh" if age <= limit_td else "stale" if age <= 2 * limit_td else "too old"
    return {"note": note, "age": age, "limit": limit, "status": status, "why": ""}


def blockers(notes: list[dict]) -> list[str]:
    """What the notes say is blocking the release."""
    found = []
    for n in notes:
        src = n.get("source")
        if src == "sprint-board" and n.get("status") != "Done":
            found.append(f"{n['id']} {n.get('title')} is still {n.get('status')}")
        elif src == "bug-list" and n.get("status") == "Open" and n.get("severity") in ("Critical", "High"):
            found.append(f"{n['id']} {n.get('title')} is open ({n.get('severity')})")
        elif src == "test-runs" and n.get("failed", 0) > 0:
            found.append(f"{n['id']} build {n.get('build')}: {n.get('failed')} of {n.get('total')} tests failed")
    return found


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Answer what is blocking the release, with the age of every note used.")
    ap.add_argument("--context", required=True, type=Path, help="the saved notes (YAML)")
    ap.add_argument("--now", required=True, help='the clock, with its time zone, e.g. "2026-10-21T15:00:00-04:00"')
    args = ap.parse_args(argv)

    now = parse_time(args.now)
    if now is None:
        print('REFUSED: --now must be a date and time with a time zone, e.g. "2026-10-21T15:00:00-04:00"')
        return 2
    try:
        data = load_context(args.context)
    except ValueError as e:
        print(f"REFUSED: the notes can't be trusted, so no answer is given: {e}")
        return 2
    limits, notes = data["limits_days"], data["notes"]

    print(f"$ .venv/bin/python participant/tools/answer-blockers.py --context {args.context} --now {args.now}")
    print(f"# answer-blockers.py {VERSION}")
    print(f"Clock set to: {shown(now)} (from --now, not the computer's clock)")
    print(f"Question: {data['question']}")
    print()

    results = [assess(n, limits, now) for n in notes]
    print("Notes used:")
    for r in results:
        n = r["note"]
        age = age_text(r["age"]) if r["age"] is not None and r["age"] >= dt.timedelta(0) else "unknown"
        limit = f"limit {r['limit']} day{'s' if r['limit'] != 1 else ''}" if r["limit"] else "no limit"
        raw = n.get("retrieved_at")
        retrieved = "NOT RECORDED" if raw in (None, "") else raw.isoformat() if isinstance(raw, dt.datetime) else str(raw)
        extra = f" -- {r['why']}" if r["why"] else ""
        print(f"  {n['id']:8} {n['source']:13} retrieved {retrieved:26} age {age:17} {limit:13} {r['status'].upper()}{extra}")
    print()

    dated = [r for r in results if r["age"] is not None and r["age"] >= dt.timedelta(0)]
    undated = [r for r in results if r["age"] is None]
    if undated:
        print("Oldest note used: " + ", ".join(r["note"]["id"] for r in undated) + " (age unknown: no usable retrieval time)")
    elif dated:
        oldest = max(dated, key=lambda r: r["age"])
        print(f"Oldest note used: {oldest['note']['id']} ({oldest['note']['source']}), {age_text(oldest['age'])} old")

    worst = max(results, key=lambda r: RANK[r["status"]])["status"]
    stale = [r for r in results if r["status"] == "stale"]
    too_old = [r for r in results if r["status"] == "too old"]
    refresh = [r["note"]["id"] for r in results if r["status"] != "fresh"]

    if worst == "too old":
        print("Answer: REFUSED. These notes are too old to rely on:")
        for r in too_old:
            print(f"  {r['note']['id']}: " + (r["why"] or f"{age_text(r['age'])} old, over twice its {r['limit']}-day limit"))
        for r in stale:
            print(f"  {r['note']['id']}: stale, {age_text(r['age'])} old, past its {r['limit']}-day limit")
        print(f"Your options: refresh these notes first, then ask again: {', '.join(refresh)}. Fresh notes don't need refreshing.")
        status = 2
    else:
        found = blockers(notes)
        print("Answer: " + ("; ".join(found) if found else "nothing in these notes is blocking the release") + ".")
        if worst == "stale":
            print("WARNING: this answer relies on stale notes and may be out of date:")
            for r in stale:
                print(f"  {r['note']['id']}: {age_text(r['age'])} old, past its {r['limit']}-day limit")
            print(f"Your options: use this answer with the caveats above, or refresh these notes first: "
                  f"{', '.join(refresh)}. Fresh notes don't need refreshing.")
            status = 1
        else:
            print("All notes are within their limits.")
            status = 0
    print(f"result: {['ANSWERED (all notes fresh)', 'WARNED (stale notes)', 'REFUSED (notes too old)'][status]} (exit status {status})")
    return status


if __name__ == "__main__":
    sys.exit(main())
