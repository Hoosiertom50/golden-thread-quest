"""A pre-check that GitHub failed to start is restarted once, then escalated (Nov 2026, PR #27)."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from test_cli_actions import ROOT

sys.path.insert(0, str(ROOT / "tools"))

import precheck_watchdog as dog

NOW = datetime(2026, 11, 9, 20, 0, tzinfo=UTC)
OLD = (NOW - timedelta(hours=2)).isoformat()


def _pr(number: int = 27, ref: str = "pilot/tom", sha: str = "aaa", pushed: str = OLD) -> dict:
    return {
        "number": number, "headRefName": ref, "headRefOid": sha, "createdAt": OLD,
        "updatedAt": pushed, "commits": [{"committedDate": pushed}],
    }  # fmt: skip


def _run(sha: str, status: str = "completed", conclusion: str | None = "success") -> dict:
    return {"headSha": sha, "status": status, "conclusion": conclusion}


def test_a_startup_failure_on_the_current_commit_is_stuck() -> None:
    assert dog.is_stuck(_pr(), [_run("aaa", conclusion="startup_failure")], NOW)


def test_no_run_at_all_on_the_current_commit_is_stuck() -> None:
    assert dog.is_stuck(_pr(), [_run("older")], NOW)


def test_a_finished_run_is_not_stuck_and_neither_is_one_in_progress() -> None:
    assert not dog.is_stuck(_pr(), [_run("aaa")], NOW)
    assert not dog.is_stuck(_pr(), [_run("aaa", "in_progress", None)], NOW)


def test_a_push_a_moment_ago_is_not_stuck() -> None:
    fresh = (NOW - timedelta(minutes=2)).isoformat()
    assert not dog.is_stuck(_pr(pushed=fresh), [], NOW)


class FakeGh:
    def __init__(self, prs: list[dict], runs: list[dict]) -> None:
        self.prs, self.runs, self.calls = prs, runs, []

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        if args[:2] == ("pr", "list"):
            return json.dumps(self.prs)
        if args[:2] == ("run", "list"):
            return json.dumps(self.runs)
        return ""

    def did(self, *prefix: str) -> bool:
        return any(call[: len(prefix)] == prefix for call in self.calls)


def test_a_stuck_pull_request_is_reopened_once_then_labelled_for_a_human(tmp_path: Path) -> None:
    said: list[str] = []
    fake = FakeGh([_pr()], [_run("aaa", conclusion="startup_failure")])

    assert dog.sweep("o/r", tmp_path, said.append, NOW, fake) == [27]
    assert fake.did("pr", "close", "27") and fake.did("pr", "reopen", "27")
    assert not fake.did("pr", "edit")

    fake.calls.clear()
    assert dog.sweep("o/r", tmp_path, said.append, NOW, fake) == [27]
    assert fake.did("pr", "edit", "27", "--repo", "o/r", "--add-label", "gtq:needs-human")
    assert not fake.did("pr", "close")

    fake.calls.clear()
    assert dog.sweep("o/r", tmp_path, said.append, NOW, fake) == []  # said once, not every run
    assert len(said) == 2


def test_other_pull_requests_and_healthy_ones_are_left_alone(tmp_path: Path) -> None:
    fake = FakeGh([_pr(ref="fix/something"), _pr(number=28, ref="pilot/ann")], [_run("aaa")])
    assert dog.sweep("o/r", tmp_path, lambda _: None, NOW, fake) == []
    assert not fake.did("pr", "close")
