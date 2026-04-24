from __future__ import annotations

import math
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Literal, Optional, Tuple

from app.comfort.baseline import Baseline, for_segment, to_dict
from app.comfort.events import (
    BUMP_THRESH,
    COOLDOWN_MS,
    HARSH_ACCEL_THRESH,
    HARSH_BRAKE_THRESH,
    SHARP_TURN_THRESH,
    SPEEDING_MARGIN_KMH,
    RideEvent,
    make_event,
)
from app.comfort.geometry import nearest_segment_id
from app.grab.client import fetch_directions_polyline6
from app.comfort.segmentation import Segment, build_segments

Comfort = Literal["green", "yellow", "red"]
EARTH_G = 9.81


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
    events: List[RideEvent] = field(default_factory=list)
    history: Deque[dict] = field(default_factory=lambda: deque(maxlen=30))
    last_t_ms: float = 0.0
    _cooldowns: Dict[Tuple[str, int], float] = field(default_factory=dict)


def create_trip() -> Trip:
    enc, points = fetch_directions_polyline6()
    segs = build_segments(points, target_len_m=55.0, max_bearing_delta_deg=22.0)
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


def _comfort_level(b: Baseline, lateral: float, brake: float, jerk: float) -> Comfort:
    lat_r = abs(lateral) / max(b.max_lateral_mps2, 0.01)
    brk_r = max(0.0, brake) / max(b.max_longitudinal_mps2, 0.01)
    jrk_r = abs(jerk) / max(b.max_jerk_mps3, 0.01)
    m = max(lat_r, brk_r, jrk_r)
    if m < 0.9:
        return "green"
    if m < 1.15:
        return "yellow"
    return "red"


def _can_fire(trip: Trip, etype: str, sid: int, t_ms: float) -> bool:
    key = (etype, sid)
    if t_ms - trip._cooldowns.get(key, -99999.0) >= COOLDOWN_MS:
        trip._cooldowns[key] = t_ms
        return True
    return False


def on_sample(
    trip: Trip,
    t_ms: float,
    lat: float,
    lng: float,
    ax: float,
    ay: float,
    az: float,
    speed_kmh: float = 0.0,
) -> dict:
    sid = nearest_segment_id(lat, lng, trip.segments, trip.ref)
    b = trip.baselines[sid] if 0 <= sid < len(trip.baselines) else trip.baselines[0]
    seg = trip.segments[sid] if 0 <= sid < len(trip.segments) else trip.segments[0]

    prev = trip.history[-1] if trip.history else None
    dt_s = max(0.01, (t_ms - float(prev["t_ms"])) / 1000.0) if prev else 0.05
    jerk = ((ax - float(prev["ax"])) / dt_s) if prev and "ax" in prev else 0.0

    lateral = ay
    brake = max(0.0, -ax)
    comfort = _comfort_level(b, lateral, brake, jerk)

    new_events: List[RideEvent] = []

    if ax < -HARSH_BRAKE_THRESH and _can_fire(trip, "harsh_brake", sid, t_ms):
        ev = make_event("harsh_brake", t_ms, lat, lng, sid, abs(ax), seg.curvature, lateral)
        trip.events.append(ev)
        new_events.append(ev)

    if ax > HARSH_ACCEL_THRESH and _can_fire(trip, "harsh_accel", sid, t_ms):
        ev = make_event("harsh_accel", t_ms, lat, lng, sid, ax, seg.curvature, lateral)
        trip.events.append(ev)
        new_events.append(ev)

    if abs(ay) > SHARP_TURN_THRESH and _can_fire(trip, "sharp_turn", sid, t_ms):
        ev = make_event("sharp_turn", t_ms, lat, lng, sid, abs(ay), seg.curvature, lateral)
        trip.events.append(ev)
        new_events.append(ev)

    vert_spike = abs(az - EARTH_G)
    if vert_spike > BUMP_THRESH and _can_fire(trip, "bump", sid, t_ms):
        ev = make_event("bump", t_ms, lat, lng, sid, vert_spike, seg.curvature)
        trip.events.append(ev)
        new_events.append(ev)

    if (
        speed_kmh > b.speed_limit_kmh + SPEEDING_MARGIN_KMH
        and abs(ay) > 1.5
        and _can_fire(trip, "speeding_risky", sid, t_ms)
    ):
        mag = (speed_kmh - b.speed_limit_kmh) / max(b.speed_limit_kmh, 1.0)
        ev = make_event("speeding_risky", t_ms, lat, lng, sid, mag, seg.curvature, lateral)
        trip.events.append(ev)
        new_events.append(ev)

    trip.history.append({"t_ms": t_ms, "ax": ax, "ay": ay, "az": az, "sid": sid})
    if sid in trip.segment_comfort:
        trip.segment_comfort[sid] = _worst(trip.segment_comfort[sid], comfort)
    trip.last_t_ms = t_ms

    return {
        "type": "state",
        "current_segment": sid,
        "segment_count": len(trip.segments),
        "comfort": comfort,
        "in_range": comfort != "red",
        "metrics": {
            "lateral_mps2": round(lateral, 2),
            "brake_mps2": round(brake, 2),
            "jerk_mps3": round(jerk, 2),
            "speed_kmh": round(speed_kmh, 1),
        },
        "baselines": to_dict(b),
        "new_events": [e.to_dict() for e in new_events],
    }


def segment_color_payload(trip: Trip) -> List[dict]:
    return [
        {"id": s.id, "level": trip.segment_comfort.get(s.id, "green")}
        for s in trip.segments
    ]


def final_score(trip: Trip) -> dict:
    segs = trip.segments
    n = max(1, len(segs))
    red = sum(1 for s in segs if trip.segment_comfort.get(s.id) == "red")
    yel = sum(1 for s in segs if trip.segment_comfort.get(s.id) == "yellow")

    score = 100.0 - 20.0 * (red / n) - 7.0 * (yel / n)
    score = max(0.0, min(100.0, math.floor(score * 10) / 10))

    # Attribution breakdown
    attr_counts: Dict[str, int] = {"driver": 0, "road": 0, "traffic": 0, "route": 0}
    for ev in trip.events:
        attr_counts[ev.attributed_to] = attr_counts.get(ev.attributed_to, 0) + 1

    total = max(1, len(trip.events))
    attribution = {k: round(v / total * 100) for k, v in attr_counts.items()}

    # Rider summary
    lines: List[str] = []
    if not trip.events:
        lines.append("Your driver delivered a smooth, comfortable ride.")
    else:
        if red:
            lines.append(f"{red} road segment(s) had rough moments.")
        elif yel:
            lines.append(f"{yel} segment(s) had minor discomfort.")
        driver_ev = attr_counts.get("driver", 0)
        road_ev = attr_counts.get("road", 0)
        traffic_ev = attr_counts.get("traffic", 0)
        if driver_ev > max(road_ev, traffic_ev):
            lines.append("Most discomfort came from driving style.")
        elif road_ev > 0:
            lines.append("Road surface conditions contributed to discomfort.")
        elif traffic_ev > 0:
            lines.append("Traffic stops caused some sudden braking.")

    # Driver coaching hints
    coaching: List[str] = []
    brake_driver = [e for e in trip.events if e.type == "harsh_brake" and e.attributed_to == "driver"]
    turn_driver = [e for e in trip.events if e.type == "sharp_turn" and e.attributed_to == "driver"]
    accel_driver = [e for e in trip.events if e.type == "harsh_accel"]
    speed_driver = [e for e in trip.events if e.type == "speeding_risky"]
    if len(brake_driver) >= 2:
        coaching.append("Anticipate stops earlier to reduce harsh braking.")
    if len(turn_driver) >= 1:
        coaching.append("Ease into turns more gradually for passenger comfort.")
    if len(accel_driver) >= 1:
        coaching.append("Smooth acceleration improves the ride experience.")
    if len(speed_driver) >= 1:
        coaching.append("Reduce speed before sharp bends.")

    return {
        "score": score,
        "summary": " ".join(lines) if lines else "Comfortable trip overall.",
        "events": [e.to_dict() for e in trip.events],
        "attribution": attribution,
        "coaching": coaching,
        "per_segment": segment_color_payload(trip),
        "stats": {
            "total_events": len(trip.events),
            "red_segments": red,
            "yellow_segments": yel,
            "green_segments": n - red - yel,
        },
    }
