"""Every non-pilot pull request gets one agent review per head commit (ADR-048)."""

from __future__ import annotations

import sys

from test_cli_actions import ROOT

sys.path.insert(0, str(ROOT / "tools"))

import pr_review as pr


def _pr(number: int, branch: str, sha: str = "aaa", draft: bool = False) -> dict[str, object]:
    return {"number": number, "headRefName": branch, "headRefOid": sha, "isDraft": draft}


def test_pilot_drafts_and_already_reviewed_heads_are_left_out() -> None:
    prs = [
        _pr(1, "fix/a"),
        _pr(2, "pilot/tom"),
        _pr(3, "fix/b", draft=True),
        _pr(4, "fix/c", sha="new"),
        _pr(5, "fix/d", sha="same"),
    ]
    assert pr.eligible(prs, {4: "old", 5: "same"}) == [1, 4]


def test_the_marker_names_the_commit_so_a_new_push_is_reviewed_again() -> None:
    assert pr.MARKER.format(sha="abc") != pr.MARKER.format(sha="abd")
