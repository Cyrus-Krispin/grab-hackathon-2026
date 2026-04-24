from __future__ import annotations

import json
import os
from typing import Any, List, Tuple

import httpx

from app.config import get_settings
from app.grab.polyline import decode_path


def _load_fixture_path() -> str:
    return os.path.join(os.path.dirname(__file__), "fixtures", "route_fixture.json")


def _fixture_points() -> List[Tuple[float, float]]:
    path = _load_fixture_path()
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    out: List[Tuple[float, float]] = []
    for p in data.get("path_lat_lng", []):
        if len(p) == 2:
            out.append((float(p[0]), float(p[1])))
    return out


def fetch_directions_polyline6() -> Tuple[str, List[Tuple[float, float]]]:
    s = get_settings()
    # Fixture: explicit flag, or no key (local dev) — see SKILL.md §3 for live shape
    if s.use_directions_fixture == 1 or not s.grab_api_key.strip():
        pts = _fixture_points()
        if len(pts) < 2:
            raise RuntimeError("Fixture has fewer than 2 points")
        return "fixture", pts

    o_lat, o_lng = s.demo_origin_lat, s.demo_origin_lng
    d_lat, d_lng = s.demo_dest_lat, s.demo_dest_lng
    # Grab gateway: each `coordinates` is **lng,lat** (SKILL.md §3, §6; example JS in SKILL)
    base = s.grab_base_url.rstrip("/")
    path = f"{base}/api/v1/maps/eta/v1/direction"
    params = [
        ("coordinates", f"{o_lng},{o_lat}"),
        ("coordinates", f"{d_lng},{d_lat}"),
        ("profile", "driving"),
        ("geometries", "polyline6"),
        ("overview", "full"),
    ]
    headers: dict[str, str] = {
        "Authorization": f"Bearer {s.grab_api_key}",
        "Accept": "application/json",
    }
    with httpx.Client(timeout=20.0) as client:
        r = client.get(path, params=params, headers=headers)
        r.raise_for_status()
        data = r.json()
    return _parse_directions(data)


def _parse_directions(data: Any) -> Tuple[str, List[Tuple[float, float]]]:
    if isinstance(data, dict) and "routes" in data and data["routes"]:
        r0 = data["routes"][0]
        enc = r0.get("geometry") or r0.get("Geometry")
    elif isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
        r0 = data["data"][0]
        enc = r0.get("geometry")
    else:
        enc = None
    if not enc:
        # Try nested common shapes
        if isinstance(data, dict):
            for k in ("route", "result"):
                v = data.get(k)
                if isinstance(v, dict) and "geometry" in v:
                    enc = v["geometry"]
                    break
    if not enc or not isinstance(enc, str):
        raise RuntimeError("Could not read geometry from directions response")

    pts = decode_path(enc)
    return enc, pts
