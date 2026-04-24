from __future__ import annotations

import math
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Literal, Tuple

from app.baseline import Baseline, for_segment, to_dict
from app.geometry import nearest_segment_id
from app.grab_client import fetch_directions_polyline6
from app.segmentation import Segment, build_segments

Comfort = Literal["green", "yellow", "red"]


def _rank(c: Comfort) -> int:
    return {"green": 0, "yellow": 1, "red": 2}[c]


def _worst(a: Comfort, b: Comfort) -> Comfort:
    return a if _rank(a) >= _rank(b) else b


@dataclass
class Trip:
    id: str
    encoded_polyline: str
    points: List[Tuple[float, float]]
    ref: Tuple[float, float]
    segments: List[Segment]
    baselines: List[Baseline]
    segment_comfort: Dict[int, Comfort] = field(default_factory=dict)
    history: Deque[dict] = field(default_factory=lambda: deque(maxlen=10))
    last_t_ms: float = 0.0


def create_trip() -> Trip:
    enc, points = fetch_directions_polyline6()
    segs = build_segments(points, target_len_m=18.0, max_bearing_delta_deg=18.0)
    if not segs:
        segs = build_segments(points, target_len_m=200.0, max_bearing_delta_deg=90.0)
    bl = [for_segment(s) for s in segs]
    ref = points[len(points) // 2]
    return Trip(
        id=str(uuid.uuid4()),
        encoded_polyline=enc,
        points=points,
        ref=ref,
        segments=segs,
        baselines=bl,
        segment_comfort={s.id: "green" for s in segs},
    )


def _instant_comfort(
    b: Baseline, lateral: float, brake: float, jerk: float
) -> tuple[Comfort, bool]:
    """Return (level, in_range) where in_range is green or yellow, not red."""
    lat_r = max(0.0, abs(lateral)) / max(b.max_lateral_mps2, 0.01)
    brk_r = max(0.0, abs(brake)) / max(b.max_longitudinal_mps2, 0.01)
    jrk_r = max(0.0, abs(jerk)) / max(b.max_jerk_mps3, 0.01)
    m = max(lat_r, brk_r, jrk_r)
    if m < 0.9:
        return "green", True
    if m < 1.15:
        return "yellow", True
    return "red", False


def on_sample(
    trip: Trip,
    t_ms: float,
    lat: float,
    lng: float,
    ax: float,
    ay: float,
    az: float,
) -> dict:
    sid = nearest_segment_id(lat, lng, trip.segments, trip.ref)
    b = trip.baselines[sid] if 0 <= sid < len(trip.baselines) else trip.baselines[0]
    prev = trip.history[-1] if trip.history else None
    dt_s = 0.05
    if prev and t_ms > prev.get("t_ms", 0):
        dt_s = max(0.01, (t_ms - float(prev["t_ms"])) / 1000.0)
    if prev and "ax" in prev:
        jerk = (ax - float(prev["ax"])) / dt_s
    else:
        jerk = 0.0
    lateral = ay
    brake = max(0.0, -ax)
    c, in_range = _instant_comfort(b, lateral, brake, jerk)
    trip.history.append(
        {
            "t_ms": t_ms,
            "ax": ax,
            "ay": ay,
            "az": az,
            "sid": sid,
            "jerk": jerk,
        }
    )
    if sid in trip.segment_comfort:
        trip.segment_comfort[sid] = _worst(trip.segment_comfort[sid], c)
    trip.last_t_ms = t_ms
    return {
        "type": "state",
        "current_segment": sid,
        "in_range": in_range,
        "comfort": c,
        "metrics": {
            "lateral_mps2": lateral,
            "brake_mps2": brake,
            "jerk_mps3": jerk,
        },
        "baselines": to_dict(b),
    }


def segment_color_payload(trip: Trip) -> List[dict]:
    out: List[dict] = []
    for s in trip.segments:
        out.append(
            {
                "id": s.id,
                "level": trip.segment_comfort.get(s.id, "green"),
            }
        )
    return out


def final_score(trip: Trip) -> dict:
    segs = trip.segments
    n = max(1, len(segs))
    score = 100.0
    red = sum(1 for s in segs if trip.segment_comfort.get(s.id) == "red")
    yel = sum(1 for s in segs if trip.segment_comfort.get(s.id) == "yellow")
    score -= 18.0 * (red / n)
    score -= 6.0 * (yel / n)
    score = max(0.0, min(100.0, math.floor(score * 10) / 10))
    lines: List[str] = []
    if red:
        lines.append(f"Rough moments on {red} segment(s).")
    if yel and not red:
        lines.append(f"Minor discomfort on {yel} segment(s).")
    if not red and not yel:
        lines.append("Consistently within comfort bands for this route.")
    return {
        "score": score,
        "summary": " ".join(lines) if lines else "Comfortable trip overall.",
        "per_segment": segment_color_payload(trip),
    }
