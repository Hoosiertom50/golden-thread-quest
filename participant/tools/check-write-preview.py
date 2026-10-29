#!/usr/bin/env python3
"""Checks the fake story tracker against the quest's acceptance criteria, the same way every run.

Part of the base-camp-write-preview quest. The recorded logs show a person using the tracker for
real, so their fingerprints and times can't repeat. This check runs the same steps in a temporary
folder with a fixed clock and a fixed time zone, so a reviewer gets the identical output each time
and can compare it with the recorded result. It never touches local-data/ or anything else in the
repository, and it writes only inside the temporary folder.

    .venv/bin/python participant/tools/check-write-preview.py \\
        --stories participant/context/write-preview/follow-up-stories.yaml
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

VERSION = "1.1.0"
ROOT = Path(__file__).resolve().parents[2]
TOOL_PATH = ROOT / "participant/tools/fake-story-tracker.py"
CLOCK = dt.datetime(2026, 10, 29, 13, 0, 0, tzinfo=dt.timezone.utc)  # 09:00 AM in Indiana
ZONE = "America/Indiana/Indianapolis"
TOKEN = "check-token-not-a-real-secret"
WHO = "Reviewer check"


def load_tool():
    spec = importlib.util.spec_from_file_location("fake_story_tracker", TOOL_PATH)
    if spec is None or spec.loader is None:
        sys.exit(f"Can't load {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def section(text: str, start: str, end: str | None) -> str:
    """The preview text from one heading up to the next, with line wrapping undone."""
    body = text.split(start, 1)[1] if start in text else ""
    if end and end in body:
        body = body.split(end, 1)[0]
    return " ".join(body.split())


def labeled_values_missing(text: str, change: dict) -> list[str]:
    """Each label followed by its exact value, looked for only where it belongs."""
    missing = []
    head = section(text, "PREVIEW", "Story 1 of")
    target = change["target"]
    for label, value in (("Target:", f"{target['system']}, project {target['project']}"),
                         ("Action:", f"{change['action']} {len(change['stories'])} stories")):
        if f"{label} {value}" not in head:
            missing.append(f"{label} {value}")
    count = len(change["stories"])
    for i, s in enumerate(change["stories"], 1):
        body = section(text, f"Story {i} of {count}", f"Story {i + 1} of {count}" if i < count
                       else "Preview fingerprint:")
        wanted = [f"Type: {s['type']}", f"Priority: {s['priority']}", f"Title: {s['title']}",
                  f"From: {s['from_question']} (answer assumed: {s['answer_assumed']})",
                  f"Description: {s['description']}"]
        wanted += [f"{j}. {c}" for j, c in enumerate(s["acceptance_criteria"], 1)]
        for w in wanted:
            if " ".join(w.split()) not in body:
                missing.append(f"story {i} {w[:40]!r}")
    return missing


def shown(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.name


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--stories", type=Path, required=True)
    ap.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    args = ap.parse_args(argv)
    os.environ["TZ"] = ZONE
    time.tzset()
    t = load_tool()
    results: list[tuple[str, bool, str]] = []

    def check(label: str, ok: bool, detail: str) -> None:
        results.append((label, ok, detail))

    def minutes(n: float) -> dt.datetime:
        return CLOCK + dt.timedelta(minutes=n)

    def refused(fn) -> str | None:
        try:
            fn()
        except t.Refused as exc:
            return str(exc)
        return None

    with tempfile.TemporaryDirectory() as tmp:
        try:
            work = Path(tmp)
            stories = work / "stories.yaml"
            shutil.copyfile(args.stories, stories)
            original = stories.read_text(encoding="utf-8")
            data = work / "tracker"
            change = t.load_change(stories)

            def state() -> str:
                return t.tracker_state(t.load_tracker(data))

            empty = state()

            # 1. The preview lists the target, the action and every field. Each label is looked for
            # with its own value inside its own story's section, so a value shown under another story
            # or another label doesn't count.
            lines, fp1 = t.do_preview(stories, data, CLOCK)
            text = "\n".join(lines)
            missing = labeled_values_missing(text, change)
            total = 2 + sum(5 + len(s["acceptance_criteria"]) for s in change["stories"])
            check("1. Preview lists target, action and every field", not missing,
                  f"{total - len(missing)} of {total} labeled values shown in the right place"
                  + (f"; missing: {missing[0]}" if missing else ""))

            # 2. Without confirmation nothing changes, and the output says so.
            no_write = state() == empty and "Nothing was written" in text
            wrong = refused(lambda: t.do_confirm(stories, data, lambda: minutes(1), "0000-0000-0000", TOKEN, WHO))
            blank = refused(lambda: t.do_confirm(stories, data, lambda: minutes(1), "", TOKEN, WHO))
            check("2. No confirmation, no change, and it says so",
                  no_write and bool(wrong) and bool(blank) and state() == empty,
                  f"tracker state {t.grouped(state())} before and after the preview, a wrong "
                  "fingerprint and a blank answer")

            # 3. The confirmation names the exact preview it approves.
            edited = original.replace("buyers can't hold", "buyers cannot hold", 1)
            check("   (the check's edit really changes the file)", edited != original,
                  "one word of story 1's title")
            stories.write_text(edited, encoding="utf-8")
            differs = refused(lambda: t.do_confirm(stories, data, lambda: minutes(2), fp1, TOKEN, WHO))
            stories.write_text(original, encoding="utf-8")

            # 5. A preview older than the limit can't be confirmed (made 20 minutes before now).
            _, fp_old = t.do_preview(stories, data, minutes(5), made_at=minutes(-15))
            stale = refused(lambda: t.do_confirm(stories, data, lambda: minutes(5), fp_old, TOKEN, WHO))
            _, fp_edge = t.do_preview(stories, data, minutes(5), made_at=minutes(-10))
            piped = subprocess.run(
                [sys.executable, str(TOOL_PATH), "confirm", "--stories", str(stories)],
                input=t.grouped(fp1) + "\n", capture_output=True, text=True, cwd=work,
                env={**os.environ, t.TOKEN_VAR: TOKEN})
            no_token = refused(lambda: t.do_confirm(stories, data, lambda: minutes(3), fp1, None, WHO))

            # The real write: a fresh, matching preview confirmed in time. If an earlier step wrongly
            # wrote anything, this is refused, and the checks below report it rather than crash.
            try:
                written_lines = t.do_confirm(stories, data, lambda: minutes(3), fp1, TOKEN, WHO)
            except t.Refused as exc:
                written_lines = [f"(refused: {exc})"]
            items = t.load_tracker(data)
            check("3. Confirmation names the exact preview",
                  len(items) == len(change["stories"])
                  and all(i["preview_fingerprint"] == fp1 for i in items),
                  f"typing {t.grouped(fp1)} wrote {len(items)} stories, each recording that fingerprint")

            # 4. A change that differs from the preview is refused, and nothing is written.
            check("4. Changed after preview: refused, nothing written",
                  bool(differs) and "title changed" in (differs or ""),
                  (differs or "not refused").split(" Nothing was written")[0])

            # 5 (continued).
            check("5. Preview older than 15 minutes: refused, nothing written",
                  bool(stale) and "expired" in (stale or ""),
                  (stale or "not refused").split(" Nothing was written")[0])
            edge = refused(lambda: t.do_confirm(stories, data, lambda: minutes(5), fp_edge, TOKEN, WHO))
            check("   (at exactly 15 minutes the preview is still valid, until the tracker changes)",
                  bool(edge) and "expired" not in (edge or "") and "tracker has changed" in (edge or ""),
                  "refused only because the stories were already written")

            # 6. The result records what was written and that a person confirmed it: every stored
            # field equals the previewed one, plus the key, who confirmed, when, and the fingerprint.
            expected = [{"key": f"TIX-{n}", **s, "confirmed_by": WHO, "confirmed_at": t.iso(minutes(3)),
                         "preview_fingerprint": fp1} for n, s in enumerate(change["stories"], 1)]
            recorded = items == expected
            again = refused(lambda: t.do_confirm(stories, data, lambda: minutes(4), fp1, TOKEN, WHO))
            dup = refused(lambda: t.do_preview(stories, data, minutes(4)))
            check("6. Result records what was written and who confirmed it",
                  recorded and bool(again) and bool(dup) and len(t.load_tracker(data)) == len(items),
                  f"{', '.join(i['key'] for i in items)} hold every previewed field unchanged, plus who, "
                  "when and the fingerprint; the same preview can't be confirmed twice, and the same "
                  "stories can't be previewed again")

            # Two confirmations of one preview at the same moment: exactly one writes. The tracker is
            # slowed down between reading and writing so the two really overlap.
            race_dir = work / "race"
            _, fp_race = t.do_preview(stories, race_dir, CLOCK)
            real_load = t.load_tracker

            def slow_load(where: Path) -> list[dict]:
                found = real_load(where)
                time.sleep(0.2)
                return found

            t.load_tracker = slow_load
            outcomes: list[str] = []

            def racer() -> None:
                try:
                    t.do_confirm(stories, race_dir, lambda: minutes(1), fp_race, TOKEN, WHO)
                    outcomes.append("written")
                except t.Refused:
                    outcomes.append("refused")

            racers = [threading.Thread(target=racer) for _ in range(2)]
            for r in racers:
                r.start()
            for r in racers:
                r.join()
            t.load_tracker = real_load
            raced = t.load_tracker(race_dir)
            check("   Two confirmations at the same moment: one write",
                  sorted(outcomes) == ["refused", "written"] and len(raced) == len(change["stories"]),
                  f"one written, one refused; the tracker holds {len(raced)} stories, not "
                  f"{2 * len(change['stories'])}")

            # Safety constraints and refusals that stand on their own.
            check("   No typed confirmation from a pipe", piped.returncode == 1 and "keyboard" in piped.stdout,
                  "an answer piped in is refused")
            check("   No token, no write", bool(no_token) and t.TOKEN_VAR in (no_token or ""),
                  f"{t.TOKEN_VAR} unset is refused")
            stored = "".join(p.read_text(encoding="utf-8") for p in data.rglob("*.json"))
            check("   The token is never stored or shown", TOKEN not in stored and TOKEN not in text
                  and TOKEN not in "\n".join(written_lines), "not in any preview, story or output")
        except t.Refused as exc:
            # A step was refused that should have worked: something earlier wrote when it
            # shouldn't have. That is a failure to report, not a crash.
            check("   Every step ran as planned", False, f"unexpected refusal: {str(exc)[:80]}")

    width = max(len(label) for label, _, _ in results)
    print(f"# check-write-preview.py {VERSION}")
    print(f"Stories: {shown(args.stories)}")
    print(f"Clock:   fixed at {t.shown_time(CLOCK)}, in a temporary folder")
    print()
    for label, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {label:<{width}}  {detail}")
    print("      7. A person can read the preview and say what will happen: judged by a person, "
          "from logs/preview.txt.")
    failed = [label for label, ok, _ in results if not ok]
    print()
    print(f"result: {'FAILED' if failed else 'PASSED'} (exit status {1 if failed else 0})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
