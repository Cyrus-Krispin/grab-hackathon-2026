from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict

# Thresholds (m/s²) — tuned so typical simulated trips aren’t flooded with incidents
HARSH_BRAKE_THRESH = 4.2    # |ax| when decelerating
HARSH_ACCEL_THRESH = 4.2    # ax when accelerating
SHARP_TURN_THRESH = 3.6     # |ay|
BUMP_THRESH = 3.4           # |az - 9.81|
SPEEDING_MARGIN_KMH = 18.0  # over limit before flagging with lateral
SPEED_OVER_LIMIT_KMH = 10.0  # plain speeding vs segment limit
JERK_ROUGH_THRESH = 30.0  # m/s³ — uneven / snappy longitudinal changes

# Min ms between same event type on same segment
COOLDOWN_MS = 4500.0

_LABELS: Dict[str, str] = {
    "harsh_brake": "Sudden braking",
    "harsh_accel": "Hard acceleration",
    "uneven_accel": "Uneven acceleration",
    "sharp_turn": "Sharp lateral movement",
    "bump": "Road surface bump",
    "speeding_risky": "High speed while turning",
    "speeding": "Over posted speed limit",
}

_ICONS: Dict[str, str] = {
    "harsh_brake": "🛑",
    "harsh_accel": "🚀",
    "uneven_accel": "📈",
    "sharp_turn": "🔄",
    "bump": "🚧",
    "speeding_risky": "⚡",
    "speeding": "🏎️",
}


@dataclass
class RideEvent:
    id: str
    type: str
    t_ms: float
    lat: float
    lng: float
    segment_id: int
    magnitude: float
    attributed_to: str  # vehicle | road | traffic | route — context, not a person
    label: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "t_ms": self.t_ms,
            "lat": self.lat,
            "lng": self.lng,
            "segment_id": self.segment_id,
            "magnitude": round(self.magnitude, 2),
            "attributed_to": self.attributed_to,
            "label": self.label,
            "icon": _ICONS.get(self.type, "⚠️"),
        }


def _attribute_brake(curvature: float, lateral: float) -> str:
    """Braking with lateral component vs straight-line stop vs mixed."""
    if abs(lateral) > 1.5:
        return "vehicle"
    if curvature < 0.005:
        return "traffic"
    return "vehicle"


def _attribute_turn(curvature: float) -> str:
    """Sharp lateral motion on curved segment vs straighter geometry."""
    if curvature > 0.018:
        return "route"
    return "vehicle"


def make_event(
    etype: str,
    t_ms: float,
    lat: float,
    lng: float,
    segment_id: int,
    magnitude: float,
    curvature: float = 0.0,
    lateral: float = 0.0,
) -> RideEvent:
    if etype == "harsh_brake":
        attr = _attribute_brake(curvature, lateral)
    elif etype == "sharp_turn":
        attr = _attribute_turn(curvature)
    elif etype == "bump":
        attr = "road"
    else:
        attr = "vehicle"

    return RideEvent(
        id=str(uuid.uuid4())[:8],
        type=etype,
        t_ms=t_ms,
        lat=lat,
        lng=lng,
        segment_id=segment_id,
        magnitude=magnitude,
        attributed_to=attr,
        label=_LABELS.get(etype, etype),
    )
