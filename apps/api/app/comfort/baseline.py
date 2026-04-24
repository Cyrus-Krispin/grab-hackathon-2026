from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from app.comfort.segmentation import Segment


@dataclass
class Baseline:
    max_lateral_mps2: float
    max_longitudinal_mps2: float   # braking
    max_jerk_mps3: float
    max_vertical_spike_mps2: float  # bump detection
    speed_limit_kmh: float          # proxy from curvature


def for_segment(s: Segment) -> Baseline:
    """
    Heuristic comfort bands from path curvature (deg/m).
    Straights: stricter lateral/jerk; bends: looser (expected movement) but
    slower speed limit.
    """
    c = s.curvature
    lat = 2.2 + min(4.5, c * 900.0)
    lon = 4.0 + min(3.5, c * 500.0)
    jerk = 2.8 + min(7.0, c * 700.0)
    vert = 2.0 + min(1.5, c * 300.0)

    # Speed limit proxy: tighter curves imply slower posted limit
    if c > 0.03:
        spd = 40.0
    elif c > 0.012:
        spd = 60.0
    else:
        spd = 80.0

    return Baseline(
        max_lateral_mps2=lat,
        max_longitudinal_mps2=lon,
        max_jerk_mps3=jerk,
        max_vertical_spike_mps2=vert,
        speed_limit_kmh=spd,
    )


def to_dict(b: Baseline) -> Dict[str, Any]:
    return {
        "max_lateral_mps2": round(b.max_lateral_mps2, 2),
        "max_longitudinal_mps2": round(b.max_longitudinal_mps2, 2),
        "max_jerk_mps3": round(b.max_jerk_mps3, 2),
        "max_vertical_spike_mps2": round(b.max_vertical_spike_mps2, 2),
        "speed_limit_kmh": b.speed_limit_kmh,
    }


def baselines_list(segments: List[Segment]) -> List[Dict[str, Any]]:
    return [to_dict(for_segment(s)) for s in segments]
