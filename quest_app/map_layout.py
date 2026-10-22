"""Where each region goes on the Quest Map, and what shape its land takes.

Pure geometry: the same regions and quest counts always give the same map, byte for byte,
so a build is reproducible and a test can hold it. Nothing here knows a region by name. A
region's land area follows its quest count (so the largest region is visibly the largest
but not absurdly so), its coastline is seeded from its id, and the picture drawn on it
comes from the `terrain` its content names.

The picture is a visual enhancement. Every region is also a link with a text label and a
count, and the page keeps the semantic card list, so nothing about progression depends on
reading the drawing (`docs/ui/SCREEN-SPECS.md`, U02).
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

# The canvas ratio is repeated in assets/css/app.css (`.map-board`), because a style
# attribute is not allowed by the Content Security Policy. A test holds the two together.
CANVAS_WIDTH = 1000.0
CANVAS_HEIGHT = 640.0
MARGIN = 28.0
# The plate each region's label sits in, in canvas units. Its text scales with the map.
LABEL_WIDTH = 176.0
LABEL_HEIGHT = 70.0

# How far a coastline may bulge past the nominal radius. The packing leaves room for it, so
# two lands never touch however the noise falls.
_BULGE = 0.15
_COAST_POINTS = 18
_GAP = 0.08  # sea left between two lands, as a fraction of their combined reach
# An archipelago spreads its area over several islets, so it needs more room than a blob.
_ARCHIPELAGO_REACH = 1.28
# Where the top edge of a region's label plate sits, below the land's centre, as a fraction
# of its radius: below the picture, over the land's lower rim.
_LABEL_TOP = 0.66
# The cluster is wider than the canvas is tall, so candidate positions fan out wider than tall.
_FAN = 1.7
# Packing scale search: the number of canvas units one square-root quest is worth.
_SCALE_MAX = 60.0
_SCALE_MIN = 4.0


@dataclass(frozen=True, slots=True)
class MapRegionInput:
    id: str
    order: int
    quest_count: int
    terrain: str


@dataclass(frozen=True, slots=True)
class MapLand:
    """One region on the map, in canvas units."""

    id: str
    terrain: str
    cx: float
    cy: float
    radius: float
    paths: tuple[str, ...]
    emblem_x: float
    emblem_y: float
    emblem_size: float
    label_x: float
    label_y: float


@dataclass(frozen=True, slots=True)
class MapLayout:
    width: float
    height: float
    lands: tuple[MapLand, ...]
    label_width: float = LABEL_WIDTH
    label_height: float = LABEL_HEIGHT


def _unit(seed: str, index: int) -> float:
    """A repeatable number in [0, 1) for this seed and index."""
    digest = hashlib.sha256(f"{seed}:{index}".encode()).digest()
    return int.from_bytes(digest[:4], "big") / 2**32


def _blob(cx: float, cy: float, radius: float, seed: str) -> str:
    """A smooth closed outline around a centre: Catmull-Rom through noisy radial points."""
    points = []
    for i in range(_COAST_POINTS):
        angle = 2 * math.pi * i / _COAST_POINTS
        wobble = 1 + _BULGE * (2 * _unit(seed, i) - 1)
        points.append(
            (cx + radius * wobble * math.cos(angle), cy + radius * wobble * math.sin(angle) * 0.9)
        )
    count = len(points)
    path = [f"M{points[0][0]:.1f},{points[0][1]:.1f}"]
    for i in range(count):
        p0, p1, p2, p3 = (
            points[(i - 1) % count],
            points[i],
            points[(i + 1) % count],
            points[(i + 2) % count],
        )
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        path.append(f"C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}")
    path.append("Z")
    return "".join(path)


def _islets(cx: float, cy: float, radius: float, seed: str) -> tuple[str, ...]:
    """One larger island and four smaller ones around it, sharing roughly one land area."""
    paths = [_blob(cx, cy, radius * 0.7, f"{seed}:main")]
    for i in range(4):
        angle = 2 * math.pi * (i + 0.3 * _unit(seed, 90 + i)) / 4 + 0.7
        reach = radius * (0.86 + 0.14 * _unit(seed, 70 + i))
        size = radius * (0.25 + 0.08 * _unit(seed, 50 + i))
        paths.append(
            _blob(
                cx + reach * math.cos(angle),
                cy + reach * math.sin(angle) * 0.85,
                size,
                f"{seed}:{i}",
            )
        )
    return tuple(paths)


def _radius(count: int) -> float:
    # Area follows the count, so a radius follows its square root.
    return math.sqrt(max(count, 1))


def _reach_factor(region: MapRegionInput) -> float:
    return _ARCHIPELAGO_REACH if region.terrain == "islands" else 1 + _BULGE


def _label_box(x: float, y: float, radius: float) -> tuple[float, float, float, float]:
    top = y + radius * _LABEL_TOP
    return (x - LABEL_WIDTH / 2, top, x + LABEL_WIDTH / 2, top + LABEL_HEIGHT)


def _box_hits_disc(
    box: tuple[float, float, float, float], cx: float, cy: float, reach: float
) -> bool:
    nearest_x = min(max(cx, box[0]), box[2])
    nearest_y = min(max(cy, box[1]), box[3])
    return math.hypot(nearest_x - cx, nearest_y - cy) < reach


def _boxes_hit(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    pad = 6.0
    return a[0] - pad < b[2] and b[0] - pad < a[2] and a[1] - pad < b[3] and b[1] - pad < a[3]


def _pack(items: list[MapRegionInput], scale: float) -> dict[str, tuple[float, float]]:
    """Centres, around the origin, for every land at this scale.

    Each region goes where its land clears every other land, and where its label clears every
    other land and every other label, nearest the middle first.
    """
    placed: dict[str, tuple[float, float]] = {}
    radius = {i.id: scale * _radius(i.quest_count) for i in items}
    reach = {i.id: radius[i.id] * _reach_factor(i) for i in items}
    boxes: dict[str, tuple[float, float, float, float]] = {}
    ordered = sorted(items, key=lambda r: (-r.quest_count, r.order, r.id))
    first = ordered[0].id
    for region in ordered:
        own = region.id
        if not placed:
            placed[own] = (0.0, 0.0)
            boxes[own] = _label_box(0.0, 0.0, radius[own])
            continue
        step = max(3.0, scale * 0.14)
        # Nothing nearer the middle than this can clear the first, largest land.
        distance = max(0.0, (reach[own] + reach[first]) * (1 + _GAP) - step)
        found: tuple[float, float] | None = None
        while found is None:
            distance += step
            for degrees in range(0, 360, 6):
                angle = math.radians(degrees + 23 * len(placed))
                x = distance * _FAN * math.cos(angle)
                y = distance * math.sin(angle)
                box = _label_box(x, y, radius[own])
                if all(
                    math.hypot(x - ox, y - oy) >= (reach[own] + reach[other]) * (1 + _GAP)
                    and not _box_hits_disc(box, ox, oy, reach[other])
                    and not _box_hits_disc(boxes[other], x, y, reach[own])
                    and not _boxes_hit(box, boxes[other])
                    for other, (ox, oy) in placed.items()
                ):
                    found = (x, y)
                    break
        placed[own] = found
        boxes[own] = _label_box(found[0], found[1], radius[own])
    return placed


def _extent(
    items: list[MapRegionInput], placed: dict[str, tuple[float, float]], scale: float
) -> tuple[float, float, float, float]:
    lo_x = lo_y = math.inf
    hi_x = hi_y = -math.inf
    for item in items:
        x, y = placed[item.id]
        r = scale * _radius(item.quest_count)
        reach = r * _reach_factor(item)
        box = _label_box(x, y, r)
        lo_x = min(lo_x, x - reach, box[0])
        hi_x = max(hi_x, x + reach, box[2])
        lo_y = min(lo_y, y - reach, box[1])
        hi_y = max(hi_y, y + reach, box[3])
    return lo_x, lo_y, hi_x, hi_y


def build_layout(items: list[MapRegionInput]) -> MapLayout:
    if not items:
        return MapLayout(CANVAS_WIDTH, CANVAS_HEIGHT, ())
    room_x, room_y = CANVAS_WIDTH - 2 * MARGIN, CANVAS_HEIGHT - 2 * MARGIN

    # The largest scale at which everything, labels included, fits the canvas. Bisection,
    # since a smaller scale only ever makes the packing smaller.
    low, high = _SCALE_MIN, _SCALE_MAX
    best: tuple[float, dict[str, tuple[float, float]]] | None = None
    for _ in range(7 if len(items) <= 16 else 4):
        middle = (low + high) / 2
        placed = _pack(items, middle)
        lo_x, lo_y, hi_x, hi_y = _extent(items, placed, middle)
        if hi_x - lo_x <= room_x and hi_y - lo_y <= room_y:
            best, low = (middle, placed), middle
        else:
            high = middle
    if best is None:  # too many regions to fit even at the smallest scale: shrink the whole map
        scale = _SCALE_MIN
        placed = _pack(items, scale)
        lo_x, lo_y, hi_x, hi_y = _extent(items, placed, scale)
        shrink = min(room_x / (hi_x - lo_x), room_y / (hi_y - lo_y), 1.0)
        scale *= shrink
        placed = {key: (x * shrink, y * shrink) for key, (x, y) in placed.items()}
    else:
        scale, placed = best
    lo_x, lo_y, hi_x, hi_y = _extent(items, placed, scale)
    offset_x = (CANVAS_WIDTH - (hi_x + lo_x)) / 2
    offset_y = (CANVAS_HEIGHT - (hi_y + lo_y)) / 2

    lands = []
    for item in sorted(items, key=lambda r: (r.order, r.id)):
        x, y = placed[item.id]
        radius = scale * _radius(item.quest_count)
        cx, cy = x + offset_x, y + offset_y
        paths = (
            _islets(cx, cy, radius, item.id)
            if item.terrain == "islands"
            else (_blob(cx, cy, radius, item.id),)
        )
        size = radius * 1.34
        lands.append(
            MapLand(
                id=item.id,
                terrain=item.terrain,
                cx=round(cx, 1),
                cy=round(cy, 1),
                radius=round(radius, 1),
                paths=paths,
                emblem_x=round(cx - size / 2, 1),
                emblem_y=round(cy - size / 2 - radius * 0.12, 1),
                emblem_size=round(size, 1),
                label_x=round(cx, 1),
                label_y=round(cy + radius * _LABEL_TOP + LABEL_HEIGHT / 2, 1),
            )
        )
    return MapLayout(CANVAS_WIDTH, CANVAS_HEIGHT, tuple(lands))
