from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from app.segmentation import Segment


@dataclass
class Baseline:
    max_lateral_mps2: float
    max_jerk_mps3: float
    max_longitudinal_mps2: float  # braking (positive = harsh decel)


def for_segment(s: Segment) -> Baseline:
    """Heuristic bands from path curvature (deg/m); stricter on straights, looser in bends."""
    c = s.curvature
    lat = 2.2 + min(4.5, c * 900.0)
    jerk = 2.8 + min(7.0, c * 700.0)
    lon = 4.0 + min(3.5, c * 500.0)
    return Baseline(
        max_lateral_mps2=lat,
        max_jerk_mps3=jerk,
        max_longitudinal_mps2=lon,
    )


def to_dict(b: Baseline) -> Dict[str, float]:
    return {
        "max_lateral_mps2": b.max_lateral_mps2,
        "max_jerk_mps3": b.max_jerk_mps3,
        "max_longitudinal_mps2": b.max_longitudinal_mps2,
    }


def baselines_list(segments: List[Segment]) -> List[Dict[str, float]]:
    return [to_dict(for_segment(s)) for s in segments]
