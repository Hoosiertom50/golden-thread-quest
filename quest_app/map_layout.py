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
import heapq
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
class MapDecor:
    """The scenery under and between the regions. Decoration only: nothing in it is data."""

    continent: tuple[str, ...] = ()
    rivers: tuple[str, ...] = ()
    lakes: tuple[str, ...] = ()
    mountains: tuple[tuple[float, float, float], ...] = ()
    trees: tuple[tuple[float, float, float], ...] = ()
    waves: tuple[tuple[float, float], ...] = ()
    ships: tuple[tuple[float, float], ...] = ()
    compass: tuple[float, float] = (0.0, 0.0)


@dataclass(frozen=True, slots=True)
class MapLayout:
    width: float
    height: float
    lands: tuple[MapLand, ...]
    label_width: float = LABEL_WIDTH
    label_height: float = LABEL_HEIGHT
    decor: MapDecor = MapDecor()


def _unit(seed: str, index: int) -> float:
    """A repeatable number in [0, 1) for this seed and index."""
    digest = hashlib.sha256(f"{seed}:{index}".encode()).digest()
    return int.from_bytes(digest[:4], "big") / 2**32


def _blob(
    cx: float,
    cy: float,
    radius: float,
    seed: str,
    bulge: float = _BULGE,
    count: int = _COAST_POINTS,
) -> str:
    """A smooth closed outline around a centre: Catmull-Rom through noisy radial points."""
    points = []
    for i in range(count):
        angle = 2 * math.pi * i / count
        wobble = 1 + bulge * (2 * _unit(seed, i) - 1)
        points.append(
            (cx + radius * wobble * math.cos(angle), cy + radius * wobble * math.sin(angle) * 0.9)
        )
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
    layout = MapLayout(CANVAS_WIDTH, CANVAS_HEIGHT, tuple(lands))
    return MapLayout(layout.width, layout.height, layout.lands, decor=_scenery(layout))


# ---------------------------------------------------------------------------------------
# Scenery. A continent under the regions, and rivers, lakes, mountains, forests, waves and
# ships in whatever room is left. Every piece is placed by rejection against the lands and
# their labels, from numbers seeded by the layout, so the same map comes out every build and
# nothing is ever drawn where it could hide a region or its name.
# ---------------------------------------------------------------------------------------

_SCENE = "scenery"
_EDGE = 30.0  # nothing is placed nearer the canvas edge than this
_COAST_INSET = 52.0  # the continent's coast stays this far inside the frame


def _reach_of(land: MapLand) -> float:
    return land.radius * (_ARCHIPELAGO_REACH if land.terrain == "islands" else 1 + _BULGE)


def _clearance(x: float, y: float, layout: MapLayout) -> float:
    """How far a point is from the nearest land or label, negative when it is on one."""
    best = math.inf
    half_w, half_h = layout.label_width / 2, layout.label_height / 2
    for land in layout.lands:
        best = min(best, math.hypot(x - land.cx, y - land.cy) - _reach_of(land))
        dx = max(abs(x - land.label_x) - half_w, 0.0)
        dy = max(abs(y - land.label_y) - half_h, 0.0)
        best = min(best, math.hypot(dx, dy) if (dx or dy) else -1.0)
    return best


def _continent_discs(layout: MapLayout) -> list[tuple[float, float, float]]:
    """Discs whose union is the continent: each land, grown, plus a bridge to its neighbours."""

    def held(cx: float, cy: float, wanted: float, least: float) -> float:
        """Grow a disc as far as `wanted`, but keep its coast clear of the frame."""
        room = min(
            cx - _COAST_INSET,
            layout.width - _COAST_INSET - cx,
            cy - _COAST_INSET,
            layout.height - _COAST_INSET - cy,
        )
        return max(least, min(wanted, room))

    discs = [
        (land.cx, land.cy, held(land.cx, land.cy, _reach_of(land) * 1.5, _reach_of(land) * 1.1))
        for land in layout.lands
    ]
    for land in layout.lands:
        others = sorted(
            (other for other in layout.lands if other is not land),
            key=lambda o: math.hypot(o.cx - land.cx, o.cy - land.cy),
        )
        for other in others[:2]:
            gap = math.hypot(other.cx - land.cx, other.cy - land.cy)
            mx, my = (land.cx + other.cx) / 2, (land.cy + other.cy) / 2
            discs.append((mx, my, held(mx, my, gap * 0.42, 0.0)))
    return discs


def _on_continent(
    x: float, y: float, discs: list[tuple[float, float, float]], scale: float = 1.0
) -> bool:
    return any(math.hypot(x - cx, y - cy) <= r * scale for cx, cy, r in discs)


def _smooth_open(points: list[tuple[float, float]]) -> str:
    if len(points) < 3:
        return ""
    path = [f"M{points[0][0]:.1f},{points[0][1]:.1f}"]
    last = len(points) - 1
    for i in range(last):
        p0, p1 = points[max(i - 1, 0)], points[i]
        p2, p3 = points[i + 1], points[min(i + 2, last)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        path.append(f"C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}")
    return "".join(path)


def _inside(x: float, y: float, layout: MapLayout, margin: float = _EDGE) -> bool:
    return margin <= x <= layout.width - margin and margin <= y <= layout.height - margin


def _scenery(layout: MapLayout) -> MapDecor:
    if not layout.lands:
        return MapDecor()
    discs = _continent_discs(layout)
    continent = tuple(
        _blob(cx, cy, r, f"{_SCENE}:c{i}", bulge=0.2, count=22)
        for i, (cx, cy, r) in enumerate(discs)
    )

    # Mountain ranges: a short curved row of peaks, set where there is room.
    mountains: list[tuple[float, float, float]] = []
    ranges: list[tuple[float, float]] = []
    for i in range(400):
        if len(ranges) >= 9:
            break
        x = _EDGE + (layout.width - 2 * _EDGE) * _unit(f"{_SCENE}:mx", i)
        y = _EDGE + (layout.height - 2 * _EDGE) * _unit(f"{_SCENE}:my", i)
        if not _on_continent(x, y, discs, 0.95) or _clearance(x, y, layout) < 34:
            continue
        if any(math.hypot(x - rx, y - ry) < 150 for rx, ry in ranges):
            continue
        ranges.append((x, y))
        tilt = 2 * math.pi * _unit(f"{_SCENE}:mt", i)
        for k in range(-2, 3):
            size = 15 + 7 * _unit(f"{_SCENE}:ms", i * 7 + k)
            px = x + k * 17 * math.cos(tilt) + 5 * math.sin(k * 1.7)
            py = y + k * 17 * math.sin(tilt) * 0.6 + 6 * math.cos(k * 1.3)
            if _inside(px, py, layout) and _clearance(px, py, layout) > 14:
                mountains.append((round(px, 1), round(py, 1), round(size, 1)))

    # Forests: small clusters of trees.
    trees: list[tuple[float, float, float]] = []
    woods: list[tuple[float, float]] = []
    for i in range(500):
        if len(woods) >= 13:
            break
        x = _EDGE + (layout.width - 2 * _EDGE) * _unit(f"{_SCENE}:fx", i)
        y = _EDGE + (layout.height - 2 * _EDGE) * _unit(f"{_SCENE}:fy", i)
        if not _on_continent(x, y, discs, 0.95) or _clearance(x, y, layout) < 26:
            continue
        if any(math.hypot(x - wx, y - wy) < 58 for wx, wy in woods) or any(
            math.hypot(x - mx, y - my) < 30 for mx, my, _ in mountains
        ):
            continue
        woods.append((x, y))
        for k in range(9):
            angle = 2 * math.pi * _unit(f"{_SCENE}:fa{i}", k)
            reach = 24 * math.sqrt(_unit(f"{_SCENE}:fr{i}", k))
            px, py = x + reach * math.cos(angle), y + reach * math.sin(angle) * 0.8
            if _inside(px, py, layout) and _clearance(px, py, layout) > 9:
                trees.append(
                    (round(px, 1), round(py, 1), round(8 + 5 * _unit(f"{_SCENE}:fs{i}", k), 1))
                )

    # Lakes.
    lakes: list[str] = []
    for i in range(300):
        if len(lakes) >= 2:
            break
        x = _EDGE + (layout.width - 2 * _EDGE) * _unit(f"{_SCENE}:lx", i)
        y = _EDGE + (layout.height - 2 * _EDGE) * _unit(f"{_SCENE}:ly", i)
        if _on_continent(x, y, discs, 0.9) and _clearance(x, y, layout) > 30:
            if all(math.hypot(x - mx, y - my) > 40 for mx, my, _ in mountains):
                lakes.append(
                    _blob(
                        x,
                        y,
                        15 + 8 * _unit(f"{_SCENE}:lr", i),
                        f"{_SCENE}:lake{i}",
                        bulge=0.3,
                        count=12,
                    )
                )

    # Rivers: each runs from the foot of a mountain range to the sea, by the cheapest way
    # through the gaps between the regions (a grid search whose costs are jittered, so it
    # wanders like water), and never over a region or its label.
    cell = 12.0
    cols, rows = int(layout.width // cell), int(layout.height // cell)
    free: dict[tuple[int, int], float] = {}
    land_cells: set[tuple[int, int]] = set()
    for j in range(rows):
        for i in range(cols):
            cx, cy = (i + 0.5) * cell, (j + 0.5) * cell
            if _on_continent(cx, cy, discs, 0.96):
                land_cells.add((i, j))
            if _inside(cx, cy, layout, 20):
                free[(i, j)] = _clearance(cx, cy, layout)
    # Sea is water that connects to the edge of the map; a gap inside the continent is not.
    sea: set[tuple[int, int]] = set()
    edge = [
        (i, j) for i in range(cols) for j in range(rows) if i in (0, cols - 1) or j in (0, rows - 1)
    ]
    pending = [cell_ for cell_ in edge if cell_ not in land_cells]
    sea.update(pending)
    while pending:
        i, j = pending.pop()
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nxt = (i + di, j + dj)
            if (
                0 <= nxt[0] < cols
                and 0 <= nxt[1] < rows
                and nxt not in land_cells
                and nxt not in sea
            ):
                sea.add(nxt)
                pending.append(nxt)
    found: list[tuple[int, str]] = []
    for index, (sx, sy) in enumerate(ranges):
        start = min(
            free,
            key=lambda c, sx=sx, sy=sy: math.hypot(
                (c[0] + 0.5) * cell - sx, (c[1] + 0.5) * cell - sy + 14
            ),
            default=None,
        )
        if start is None:
            continue
        best_cost: dict[tuple[int, int], float] = {start: 0.0}
        came: dict[tuple[int, int], tuple[int, int]] = {}
        queue: list[tuple[float, tuple[int, int]]] = [(0.0, start)]
        goal: tuple[int, int] | None = None
        while queue:
            cost, here = heapq.heappop(queue)
            if cost > best_cost.get(here, math.inf):
                continue
            if here in sea:
                goal = here
                break
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                nxt = (here[0] + di, here[1] + dj)
                room = free.get(nxt)
                if room is None:
                    continue
                jitter = 1 + 0.9 * _unit(f"{_SCENE}:rv{index}", nxt[0] * 131 + nxt[1])
                # Over a region or its label costs a lot, because the river is hidden there;
                # beside one costs a little, so it keeps to the open ground.
                crowding = 14.0 if room < 0 else (6.0 - min(room, 6.0)) * 0.25
                step = (1.41 if di and dj else 1.0) * jitter + crowding
                if cost + step < best_cost.get(nxt, math.inf):
                    best_cost[nxt] = cost + step
                    came[nxt] = here
                    heapq.heappush(queue, (cost + step, nxt))
        if goal is None:
            continue
        cells = [goal]
        while cells[-1] in came:
            cells.append(came[cells[-1]])
        cells.reverse()
        if len(cells) < 9:
            continue
        points = [((i + 0.5) * cell, (j + 0.5) * cell) for i, j in cells[::2]]
        found.append((len(points), _smooth_open(points)))
    rivers = [path for _, path in sorted(found, key=lambda f: -f[0])[:3]]

    # Open sea: wave marks, and a ship or two.
    waves: list[tuple[float, float]] = []
    for i in range(600):
        if len(waves) >= 30:
            break
        x = 24 + (layout.width - 48) * _unit(f"{_SCENE}:wx", i)
        y = 24 + (layout.height - 48) * _unit(f"{_SCENE}:wy", i)
        if _on_continent(x, y, discs, 1.1) or _clearance(x, y, layout) < 30:
            continue
        if all(math.hypot(x - wx, y - wy) > 62 for wx, wy in waves):
            waves.append((round(x, 1), round(y, 1)))
    ships = tuple(waves[i] for i in (3, 11) if i < len(waves))
    waves = [w for w in waves if w not in ships]

    # The compass goes in whichever corner has the most room.
    corners = [
        (layout.width - 62, 62),
        (62, 62),
        (62, layout.height - 62),
        (layout.width - 62, layout.height - 62),
    ]
    compass = max(corners, key=lambda c: _clearance(c[0], c[1], layout))

    return MapDecor(
        continent=continent,
        rivers=tuple(rivers),
        lakes=tuple(lakes),
        mountains=tuple(mountains),
        trees=tuple(trees),
        waves=tuple(waves),
        ships=ships,
        compass=compass,
    )
