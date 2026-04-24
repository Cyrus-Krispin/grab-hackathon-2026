from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict

# Thresholds (m/s²)
HARSH_BRAKE_THRESH = 3.5    # |ax| when decelerating
HARSH_ACCEL_THRESH = 3.5    # ax when accelerating
SHARP_TURN_THRESH = 3.0     # |ay|
BUMP_THRESH = 2.8           # |az - 9.81|
SPEEDING_MARGIN_KMH = 15.0  # over limit before flagging with lateral

# Min ms between same event type on same segment
COOLDOWN_MS = 2500.0

_LABELS: Dict[str, str] = {
    "harsh_brake": "Sudden braking",
    "harsh_accel": "Hard acceleration",
    "sharp_turn": "Sharp lateral movement",
    "bump": "Road surface bump",
    "speeding_risky": "Speeding with sharp movement",
}

_ICONS: Dict[str, str] = {
    "harsh_brake": "🛑",
    "harsh_accel": "🚀",
    "sharp_turn": "🔄",
    "bump": "🚧",
    "speeding_risky": "⚡",
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
    attributed_to: str  # driver | road | traffic | route
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
    """Braking with lateral swerve → driver; braking on straight → likely traffic stop."""
    if abs(lateral) > 1.5:
        return "driver"
    if curvature < 0.005:
        return "traffic"
    return "driver"


def _attribute_turn(curvature: float) -> str:
    """Sharp turn on a genuinely curved segment → route geometry; else → driver."""
    if curvature > 0.018:
        return "route"
    return "driver"


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
        attr = "driver"

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
