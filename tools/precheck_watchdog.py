"""Notice a pilot hand-in whose pre-check never ran, and start it again.

The Forge reviewer only picks up a pull request labelled `gtq:ready-for-review`, and only the
pre-check (`.github/workflows/pilot-precheck.yml`) sets that label. When GitHub fails to start
that workflow (`startup_failure`), nothing says so: the participant waits and the label never
changes. This runs from the reviewer's timer. For each open `pilot/*` pull request whose current
commit has no finished pre-check, it closes and reopens the pull request once, which starts the
workflow again, and tells the owner. If that does not help, it labels the pull request
`gtq:needs-human` and tells the owner once more. Stdlib only; `gh` is the machine's own login.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

WORKFLOW = "pilot-precheck.yml"
# Long enough for a pre-check to start and finish (it takes about 30 seconds), and for GitHub to
# queue it, so a push a moment ago is never called stuck.
GRACE = timedelta(minutes=10)
FINISHED_WELL = {"success", "skipped"}

Gh = Callable[..., str]


def gh(*args: str) -> str:
    done = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120, check=False)  # noqa: S603, S607
    if done.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:2])}: {done.stderr.strip()[:200]}")
    return done.stdout


def _when(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def is_stuck(pr: dict[str, Any], runs: list[dict[str, Any]], now: datetime) -> bool:
    """True when this pull request's current commit has no pre-check that finished well.

    A run still queued or in progress is not stuck, and nothing is stuck before `GRACE`.
    """
    commits = pr.get("commits") or []
    pushed = max((_when(c["committedDate"]) for c in commits), default=_when(pr["updatedAt"]))
    if now - max(pushed, _when(pr["createdAt"])) < GRACE:
        return False
    mine = [r for r in runs if r.get("headSha") == pr["headRefOid"]]
    if any(r.get("status") != "completed" for r in mine):
        return False
    return not any(r.get("conclusion") in FINISHED_WELL for r in mine)


def sweep(
    repo: str, state: Path, notify: Callable[[str], None], now: datetime | None = None, run: Gh = gh
) -> list[int]:
    """Restart stuck pre-checks. Returns the pull requests it acted on."""
    now = now or datetime.now(timezone.utc)
    path = state / "precheck-watchdog.json"
    try:
        tried: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        tried = {}
    prs = json.loads(
        run("pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json",
            "number,headRefName,headRefOid,createdAt,updatedAt,commits")
    )  # fmt: skip
    acted: list[int] = []
    for pr in prs:
        if not pr["headRefName"].startswith("pilot/"):
            continue
        number = pr["number"]
        runs = json.loads(
            run("run", "list", "--repo", repo, "--workflow", WORKFLOW, "--branch",
                pr["headRefName"], "--limit", "20", "--json", "headSha,status,conclusion")
        )  # fmt: skip
        if not is_stuck(pr, runs, now):
            tried.pop(str(number), None)
            continue
        sha = pr["headRefOid"]
        if tried.get(str(number)) == sha:
            # Already restarted once for this commit and it is still not through.
            run("label", "create", "gtq:needs-human", "--repo", repo, "--force")
            run("pr", "edit", str(number), "--repo", repo, "--add-label", "gtq:needs-human")
            notify(f"PR #{number}: the pre-check still has not run after a restart. It needs you.")
            tried[str(number)] = f"{sha}:escalated"
        elif str(tried.get(str(number), "")).endswith(":escalated") and tried[
            str(number)
        ].startswith(sha):
            continue
        else:
            run("pr", "close", str(number), "--repo", repo)
            run("pr", "reopen", str(number), "--repo", repo)
            notify(f"PR #{number}: the pre-check never ran, so I restarted it.")
            tried[str(number)] = sha
        acted.append(number)
    path.write_text(json.dumps(tried), encoding="utf-8")
    return acted
