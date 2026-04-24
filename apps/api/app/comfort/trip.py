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
    JERK_ROUGH_THRESH,
    SHARP_TURN_THRESH,
    SPEEDING_MARGIN_KMH,
    SPEED_OVER_LIMIT_KMH,
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


def _bearing_deg(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


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


def create_trip(
    origin: Optional[Tuple[float, float]] = None,
    destination: Optional[Tuple[float, float]] = None,
) -> Trip:
    enc, points = fetch_directions_polyline6(origin, destination)
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


def _comfort_minimum_for_event(etype: str) -> Comfort:
    """Discrete detections should affect trip score; bumps are milder on the segment band."""
    if etype == "bump":
        return "yellow"
    return "red"


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
    heading = (
        _bearing_deg((float(prev["lat"]), float(prev["lng"])), (lat, lng))
        if prev and "lat" in prev and "lng" in prev
        else 0.0
    )

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

    if (
        prev
        and abs(jerk) > JERK_ROUGH_THRESH
        and 0.8 <= ax < HARSH_ACCEL_THRESH
        and _can_fire(trip, "uneven_accel", sid, t_ms)
    ):
        ev = make_event("uneven_accel", t_ms, lat, lng, sid, abs(jerk), seg.curvature, lateral)
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
    elif speed_kmh > b.speed_limit_kmh + SPEED_OVER_LIMIT_KMH and _can_fire(trip, "speeding", sid, t_ms):
        mag = speed_kmh - b.speed_limit_kmh
        ev = make_event("speeding", t_ms, lat, lng, sid, mag, seg.curvature, lateral)
        trip.events.append(ev)
        new_events.append(ev)

    for ev in new_events:
        sid_ev = ev.segment_id
        if sid_ev in trip.segment_comfort:
            trip.segment_comfort[sid_ev] = _worst(
                trip.segment_comfort[sid_ev], _comfort_minimum_for_event(ev.type)
            )

    trip.history.append({"t_ms": t_ms, "lat": lat, "lng": lng, "ax": ax, "ay": ay, "az": az, "sid": sid})
    if sid in trip.segment_comfort:
        trip.segment_comfort[sid] = _worst(trip.segment_comfort[sid], comfort)
    trip.last_t_ms = t_ms

    return {
        "type": "state",
        "t_ms": round(t_ms, 1),
        "current_segment": sid,
        "segment_count": len(trip.segments),
        "comfort": comfort,
        "in_range": comfort != "red",
        "position": {
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "heading_deg": round(heading, 1),
        },
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


_EVENT_IMPACT: Dict[str, float] = {
    "harsh_brake": 5.5,
    "harsh_accel": 4.8,
    "uneven_accel": 3.5,
    "sharp_turn": 4.8,
    "bump": 3.8,
    "speeding_risky": 6.5,
    "speeding": 4.5,
}


def final_score(trip: Trip) -> dict:
    segs = trip.segments
    n = max(1, len(segs))
    red = sum(1 for s in segs if trip.segment_comfort.get(s.id) == "red")
    yel = sum(1 for s in segs if trip.segment_comfort.get(s.id) == "yellow")

    # Segment blend: how rough the route felt along distance
    seg_score = 100.0 - 22.0 * (red / n) - 8.0 * (yel / n)
    # Event blend: discrete incidents always cap the score (fixes all-green segments + rounding to 100)
    ev_deduction = min(
        42.0,
        sum(_EVENT_IMPACT.get(e.type, 5.0) for e in trip.events),
    )
    ev_score = max(0.0, 100.0 - ev_deduction)
    score = min(seg_score, ev_score)
    score = max(0.0, min(100.0, math.floor(score * 10) / 10))

    event_counts: Dict[str, int] = {}
    for ev in trip.events:
        event_counts[ev.type] = event_counts.get(ev.type, 0) + 1

    lines: List[str] = []
    if not trip.events:
        lines.append("No notable motion events along this route.")
    else:
        if red:
            lines.append(f"{red} segment(s) registered elevated roughness.")
        elif yel:
            lines.append(f"{yel} segment(s) had mild roughness.")
        sp = sum(1 for e in trip.events if e.type in ("speeding", "speeding_risky"))
        ua = sum(1 for e in trip.events if e.type in ("harsh_accel", "uneven_accel"))
        if sp:
            lines.append(f"Speed vs limit: {sp} moment(s) detected.")
        if ua:
            lines.append(f"Acceleration: {ua} notable spike(s).")

    return {
        "score": score,
        "summary": " ".join(lines) if lines else "Comfortable trip overall.",
        "events": [e.to_dict() for e in trip.events],
        "event_counts": event_counts,
        "per_segment": segment_color_payload(trip),
        "stats": {
            "total_events": len(trip.events),
            "red_segments": red,
            "yellow_segments": yel,
            "green_segments": n - red - yel,
        },
    }
