"""The evidence page offers a refresh beside "Not detected", because it is a build-time snapshot."""

from __future__ import annotations

from pathlib import Path

from quest_app.build import build_site
from quest_app.config import AppConfig
from quest_app.errors import ProblemReport
from quest_app.pipeline import load_world
from quest_app.view_models import offline_service_view, online_service_view
from test_cli_actions import REVIEWED, run, unlock


def _started_page(content_repo: Path, tmp_path: Path, *, online: bool) -> str:
    participant = tmp_path / "participant"
    unlock(participant, REVIEWED)
    started = run(participant, "start-quest", "--quest", REVIEWED)
    assert started.returncode == 0, started.stderr
    config = AppConfig.for_repo(content_repo, participant_root=participant)
    world = load_world(config, ProblemReport())
    assert world is not None
    build_site(world, service=online_service_view() if online else offline_service_view())
    return (config.generated_root / "evidence" / REVIEWED / "index.html").read_text(
        encoding="utf-8"
    )


def test_the_page_offers_a_refresh_and_says_when_it_was_built(
    content_repo: Path, tmp_path: Path
) -> None:
    html = _started_page(content_repo, tmp_path, online=True)
    assert "Refresh this page" in html
    assert f"/api/action/rebuild/{REVIEWED}/" in html
    assert "still says <strong>Not detected</strong>" in html


def test_offline_the_refresh_is_disabled_and_says_how_to_do_it_instead(
    content_repo: Path, tmp_path: Path
) -> None:
    html = _started_page(content_repo, tmp_path, online=False)
    assert "Refresh this page" in html
    assert "gtq action rebuild" in html
