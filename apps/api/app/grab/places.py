from __future__ import annotations

from typing import Any, Dict, List

import httpx

from app.config import get_settings

# Singapore centroid for POI search bias (lat,lng in query per SKILL.md)
SG_BIAS_LAT = 1.3521
SG_BIAS_LNG = 103.8198


def _extract_grab_rows(data: Any) -> List[dict]:
    if not isinstance(data, dict):
        return []
    for key in ("data", "results", "places", "pois", "items", "searchResults"):
        rows = data.get(key)
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict)]
    if isinstance(data.get("result"), dict):
        inner = data["result"]
        for key in ("data", "places", "pois"):
            rows = inner.get(key)
            if isinstance(rows, list):
                return [r for r in rows if isinstance(r, dict)]
    return []


def _normalize_grab_places(data: Any, limit: int) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i, row in enumerate(_extract_grab_rows(data)):
        if len(out) >= limit:
            break
        lat = row.get("latitude") or row.get("lat")
        lng = row.get("longitude") or row.get("lng")
        loc = row.get("location") or row.get("position") or {}
        if isinstance(loc, dict):
            lat = lat or loc.get("latitude") or loc.get("lat")
            lng = lng or loc.get("longitude") or loc.get("lng")
        if lat is None or lng is None:
            continue
        try:
            lat_f = float(lat)
            lng_f = float(lng)
        except (TypeError, ValueError):
            continue
        name = row.get("name") or row.get("title") or row.get("poiName") or "Place"
        addr = row.get("address") or row.get("formattedAddress") or row.get("vicinity") or ""
        pid = row.get("poiId") or row.get("id") or row.get("placeId") or f"grab-{i}"
        label = str(name)
        if addr and addr not in label:
            label = f"{name} — {addr}"[:160]
        out.append({
            "id": str(pid),
            "label": label,
            "lat": lat_f,
            "lng": lng_f,
            "source": "grab",
        })
    return out


def _normalize_nominatim(data: Any, limit: int) -> List[Dict[str, Any]]:
    if not isinstance(data, list):
        return []
    out: List[Dict[str, Any]] = []
    for row in data[:limit]:
        if not isinstance(row, dict):
            continue
        try:
            lat_f = float(row["lat"])
            lng_f = float(row["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        pid = row.get("place_id") or row.get("osm_id")
        disp = row.get("display_name") or "Place"
        out.append({
            "id": f"osm:{pid}" if pid is not None else f"osm:{len(out)}",
            "label": disp[:200],
            "lat": lat_f,
            "lng": lng_f,
            "source": "osm",
        })
    return out


def search_places_singapore(query: str, limit: int = 8) -> Dict[str, Any]:
    """
    Keyword search biased to Singapore. Uses Grab POI when configured; otherwise OSM Nominatim.
    """
    q = query.strip()
    if len(q) < 2:
        return {"places": [], "source": "none", "message": "Query too short"}

    s = get_settings()
    limit = max(1, min(limit, 20))

    if s.grab_api_key.strip():
        base = s.grab_base_url.rstrip("/")
        url = f"{base}/api/v1/maps/poi/v1/search"
        params = {
            "keyword": q,
            "country": "SGP",
            "location": f"{SG_BIAS_LAT},{SG_BIAS_LNG}",
            "limit": str(limit),
        }
        headers = {"Authorization": f"Bearer {s.grab_api_key}", "Accept": "application/json"}
        try:
            with httpx.Client(timeout=15.0) as client:
                r = client.get(url, params=params, headers=headers)
                r.raise_for_status()
                data = r.json()
            places = _normalize_grab_places(data, limit)
            if places:
                return {"places": places, "source": "grab"}
        except (httpx.HTTPError, ValueError):
            pass

    # Fallback: Nominatim (Singapore only). Respect usage policy with a descriptive User-Agent.
    try:
        with httpx.Client(timeout=12.0) as client:
            r = client.get(
                "https://nominatim.openstreetmap.org/search",
                params={
                    "q": q,
                    "format": "json",
                    "countrycodes": "sg",
                    "limit": limit,
                },
                headers={"User-Agent": "grab-hackathon-ride-comfort/1.0"},
            )
            r.raise_for_status()
            places = _normalize_nominatim(r.json(), limit)
        return {
            "places": places,
            "source": "osm",
            "message": None if places else "No results",
        }
    except httpx.HTTPError:
        return {"places": [], "source": "osm", "message": "Search failed"}
