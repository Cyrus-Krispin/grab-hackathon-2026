from __future__ import annotations

import json
import os
from typing import Any, List, Optional, Tuple

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


def _osrm_route_points(origin: Tuple[float, float], destination: Tuple[float, float]) -> List[Tuple[float, float]]:
    """Public OSRM demo — driving geometry between (lat,lng) pairs. Server-side only."""
    lat1, lng1 = origin
    lat2, lng2 = destination
    url = f"https://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}"
    with httpx.Client(timeout=25.0) as client:
        r = client.get(url, params={"overview": "full", "geometries": "geojson"})
        r.raise_for_status()
        data = r.json()
    coords = data["routes"][0]["geometry"]["coordinates"]
    return [(float(c[1]), float(c[0])) for c in coords]


def fetch_directions_polyline6(
    origin: Optional[Tuple[float, float]] = None,
    destination: Optional[Tuple[float, float]] = None,
) -> Tuple[str, List[Tuple[float, float]]]:
    s = get_settings()
    if s.use_directions_fixture == 1:
        pts = _fixture_points()
        if len(pts) < 2:
            raise RuntimeError("Fixture has fewer than 2 points")
        return "fixture", pts

    o_lat, o_lng = origin if origin is not None else (s.demo_origin_lat, s.demo_origin_lng)
    d_lat, d_lng = destination if destination is not None else (s.demo_dest_lat, s.demo_dest_lng)

    if not s.grab_api_key.strip():
        if origin is not None and destination is not None:
            try:
                pts = _osrm_route_points(origin, destination)
                if len(pts) >= 2:
                    return "osrm", pts
            except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError):
                pass
        pts = _fixture_points()
        if len(pts) < 2:
            raise RuntimeError("Fixture has fewer than 2 points")
        return "fixture", pts
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
