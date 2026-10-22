"""The Quest Map's geometry: sized by quest count, never overlapping, same every time.

The layout is pure, so these hold it without a browser. The page that draws it is checked in
`tests/integration/test_quest_map.py`, and the dialogs in `tests/ui/test_browser_flows.py`.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

from quest_app import map_layout
from quest_app.map_layout import MapLand, MapLayout, MapRegionInput, build_layout

ROOT = Path(__file__).resolve().parent.parent.parent

# Nine regions shaped like the shipped curriculum, but invented here so that the test does not
# move when a quest is added.
REGIONS = [
    MapRegionInput("alpha", 10, 9, "mountain"),
    MapRegionInput("bravo", 20, 13, "ruins"),
    MapRegionInput("charlie", 30, 9, "village"),
    MapRegionInput("delta", 40, 12, "library"),
    MapRegionInput("echo", 50, 20, "maze"),
    MapRegionInput("foxtrot", 60, 23, "jungle"),
    MapRegionInput("golf", 70, 18, "cave"),
    MapRegionInput("hotel", 80, 17, "islands"),
    MapRegionInput("india", 90, 7, "swamp"),
]


def label_box(land: MapLand, layout: MapLayout) -> tuple[float, float, float, float]:
    half_w, half_h = layout.label_width / 2, layout.label_height / 2
    return (
        land.label_x - half_w,
        land.label_y - half_h,
        land.label_x + half_w,
        land.label_y + half_h,
    )


def box_touches_disc(box: tuple[float, float, float, float], land: MapLand) -> bool:
    nearest_x = min(max(land.cx, box[0]), box[2])
    nearest_y = min(max(land.cy, box[1]), box[3])
    return math.hypot(nearest_x - land.cx, nearest_y - land.cy) < land.radius


def reach(land: MapLand) -> float:
    """The room a land really takes: its radius plus the coastline's bulge or its islets."""
    factor = map_layout._ARCHIPELAGO_REACH if land.terrain == "islands" else 1 + map_layout._BULGE
    return land.radius * factor


def overlaps(layout: MapLayout) -> int:
    """How many pairs of lands, or labels, or a label and a land, touch."""
    found = 0
    for index, first in enumerate(layout.lands):
        box = label_box(first, layout)
        for second in layout.lands[index + 1 :]:
            if math.hypot(first.cx - second.cx, first.cy - second.cy) <= reach(first) + reach(
                second
            ):
                found += 1
            other = label_box(second, layout)
            if box[0] < other[2] and other[0] < box[2] and box[1] < other[3] and other[1] < box[3]:
                found += 1
        for second in layout.lands:
            if first is not second and box_touches_disc(box, second):
                found += 1
    return found


def test_the_same_regions_give_the_same_map() -> None:
    assert build_layout(REGIONS) == build_layout(list(reversed(REGIONS)))


def test_land_area_follows_quest_count() -> None:
    lands = {land.id: land for land in build_layout(REGIONS).lands}
    for first in REGIONS:
        for second in REGIONS:
            expected = math.sqrt(first.quest_count / second.quest_count)
            actual = lands[first.id].radius / lands[second.id].radius
            assert math.isclose(actual, expected, rel_tol=0.02), (first.id, second.id)


def test_no_two_lands_overlap_even_counting_the_coastline_and_the_islets() -> None:
    lands = build_layout(REGIONS).lands
    for index, first in enumerate(lands):
        for second in lands[index + 1 :]:
            gap = math.hypot(first.cx - second.cx, first.cy - second.cy)
            assert gap > reach(first) + reach(second)


def test_no_label_sits_on_another_land_or_another_label() -> None:
    layout = build_layout(REGIONS)
    for first in layout.lands:
        box = label_box(first, layout)
        for second in layout.lands:
            if first is second:
                continue
            assert not box_touches_disc(box, second), (first.id, second.id)
            other = label_box(second, layout)
            overlap = (
                box[0] < other[2] and other[0] < box[2] and box[1] < other[3] and other[1] < box[3]
            )
            assert not overlap, (first.id, second.id)


def test_everything_stays_on_the_canvas() -> None:
    layout = build_layout(REGIONS)
    for land in layout.lands:
        left, top, right, bottom = label_box(land, layout)
        assert land.cx - reach(land) >= 0 and land.cx + reach(land) <= layout.width
        assert land.cy - reach(land) >= 0
        assert left >= 0 and right <= layout.width and top >= 0 and bottom <= layout.height


def test_an_archipelago_is_several_islets_and_other_terrain_is_one_land() -> None:
    for land in build_layout(REGIONS).lands:
        assert len(land.paths) == (5 if land.terrain == "islands" else 1)


def test_lands_come_back_in_curriculum_order() -> None:
    assert [land.id for land in build_layout(REGIONS).lands] == [r.id for r in REGIONS]


def test_no_regions_and_one_region_are_fine() -> None:
    assert build_layout([]).lands == ()
    only = build_layout([MapRegionInput("solo", 1, 5, "plain")])
    assert [land.id for land in only.lands] == ["solo"]


def test_up_to_eighteen_regions_fit_without_anything_touching() -> None:
    """The limit `docs/ui/SCREEN-SPECS.md` states for the map. Past it the labels may touch."""
    many = [
        MapRegionInput(f"r{i}", i, 5 + (i * 7) % 19, "islands" if i % 7 == 3 else "plain")
        for i in range(18)
    ]
    layout = build_layout(many)
    assert len(layout.lands) == 18
    assert overlaps(layout) == 0


def test_far_more_regions_than_that_still_all_get_a_place() -> None:
    many = [MapRegionInput(f"r{i}", i, 3 + i % 9, "plain") for i in range(40)]
    assert len(build_layout(many).lands) == 40


def test_the_stylesheet_uses_the_canvas_ratio() -> None:
    """The ratio is in the stylesheet because a style attribute is blocked by the CSP."""
    css = (ROOT / "assets" / "css" / "app.css").read_text()
    match = re.search(r"\.map-board \{[^}]*aspect-ratio: (\d+) / (\d+)", css)
    assert match, ".map-board no longer declares an aspect ratio"
    assert (int(match.group(1)), int(match.group(2))) == (
        int(map_layout.CANVAS_WIDTH),
        int(map_layout.CANVAS_HEIGHT),
    )
