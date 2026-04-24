from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Tuple


@dataclass
class Segment:
    id: int
    coords: List[Tuple[float, float]]  # (lat, lng)
    length_m: float
    curvature: float  # mean bearing change per meter (deg/m)


def _haversine_m(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    r = 6_371_000.0
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def _bearing_deg(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    la1, lo1 = map(math.radians, (a[0], a[1]))
    la2, lo2 = map(math.radians, (b[0], b[1]))
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _bearing_delta(b0: float, b1: float) -> float:
    d = abs(b1 - b0) % 360
    return d if d <= 180 else 360 - d


def path_length(pts: List[Tuple[float, float]]) -> float:
    if len(pts) < 2:
        return 0.0
    return sum(_haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def build_segments(
    points: List[Tuple[float, float]],
    target_len_m: float = 55.0,
    max_bearing_delta_deg: float = 30.0,
) -> List[Segment]:
    """Split polyline (lat, lng) at target length or sharp turn; segments share an endpoint."""
    if len(points) < 2:
        return []

    runs: List[List[Tuple[float, float]]] = []
    start = 0
    acc = 0.0
    for i in range(1, len(points)):
        acc += _haversine_m(points[i - 1], points[i])
        bend = 0.0
        if 1 <= i < len(points) - 1:
            b0 = _bearing_deg(points[i - 1], points[i])
            b1 = _bearing_deg(points[i], points[i + 1])
            bend = _bearing_delta(b0, b1)
        split = acc >= target_len_m or bend >= max_bearing_delta_deg
        if split and i - start >= 1:
            runs.append(points[start : i + 1])
            start = i
            acc = 0.0
    if start < len(points):
        tail = points[start:]
        if len(tail) == 1 and runs:
            runs[-1] = list(runs[-1]) + tail
        else:
            runs.append(tail)

    if not runs:
        runs = [list(points)] if len(points) >= 2 else []
    elif any(len(r) < 2 for r in runs):
        runs = [list(points)] if len(points) >= 2 else []

    segments: List[Segment] = []
    for idx, coords in enumerate(runs):
        if len(coords) < 2:
            continue
        L = path_length(coords)
        bend_sum = 0.0
        for j in range(len(coords) - 2):
            b0 = _bearing_deg(coords[j], coords[j + 1])
            b1 = _bearing_deg(coords[j + 1], coords[j + 2])
            bend_sum += _bearing_delta(b0, b1)
        curv = (bend_sum / max(L, 1.0)) if L > 0 else 0.0
        segments.append(
            Segment(
                id=idx,
                coords=coords,
                length_m=max(L, 0.1),
                curvature=float(curv),
            )
        )
    for i, s in enumerate(segments):
        s.id = i
    return segments
