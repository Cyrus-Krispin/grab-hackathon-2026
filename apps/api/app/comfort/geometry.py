from __future__ import annotations

import math
from typing import List, Tuple

from app.comfort.segmentation import Segment


def _ll_to_m(ref: Tuple[float, float], p: Tuple[float, float]) -> Tuple[float, float]:
    """Local equirectangular meters; ref = (lat, lng)."""
    r = 6_371_000.0
    lat0 = math.radians(ref[0])
    x = (math.radians(p[1]) - math.radians(ref[1])) * math.cos(lat0) * r
    y = (math.radians(p[0]) - math.radians(ref[0])) * r
    return x, y


def _project_t(a: float, b: float, p: float) -> float:
    if b <= a + 1e-9:
        return 0.0
    t = (p - a) / (b - a)
    return min(1.0, max(0.0, t))


def _dist_point_to_edge_m(
    ref: Tuple[float, float], p: Tuple[float, float], a: Tuple[float, float], b: Tuple[float, float]
) -> float:
    ax, ay = _ll_to_m(ref, a)
    bx, by = _ll_to_m(ref, b)
    px, py = _ll_to_m(ref, p)
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    t = 0.0 if ab2 < 1e-6 else max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
    qx, qy = ax + t * abx, ay + t * aby
    return math.hypot(px - qx, py - qy)


def nearest_segment_id(lat: float, lng: float, segments: List[Segment], ref: Tuple[float, float]) -> int:
    p = (lat, lng)
    best = 0
    best_d = 1e18
    for s in segments:
        for i in range(len(s.coords) - 1):
            d = _dist_point_to_edge_m(ref, p, s.coords[i], s.coords[i + 1])
            if d < best_d:
                best_d = d
                best = s.id
    return int(best)
