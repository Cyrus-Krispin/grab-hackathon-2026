from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

from app.comfort.baseline import to_dict
from app.config import get_settings
from app.comfort.trip import (
    Trip,
    create_trip,
    final_score,
    on_sample,
    segment_color_payload,
)

import httpx

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

TRIPS: Dict[str, Trip] = {}


def _coords_to_geojson(pts: List[Tuple[float, float]]) -> List[List[float]]:
    return [[p[1], p[0]] for p in pts]  # (lat,lng) → [lng,lat] for GeoJSON


def build_geojson(trip: Trip) -> Dict[str, Any]:
    features: List[Dict[str, Any]] = []
    for s in trip.segments:
        features.append({
            "type": "Feature",
            "properties": {
                "id": s.id,
                "comfort": trip.segment_comfort.get(s.id, "green"),
                "curvature": round(s.curvature, 4),
                "length_m": round(s.length_m, 1),
            },
            "geometry": {
                "type": "LineString",
                "coordinates": _coords_to_geojson(s.coords),
            },
        })
    return {"type": "FeatureCollection", "features": features}


def _midpoint(coords: List[Tuple[float, float]]) -> Tuple[float, float]:
    if not coords:
        return (0.0, 0.0)
    return coords[len(coords) // 2]


def _demo_segment_counts(segment_id: int) -> Dict[str, int]:
    if segment_id % 13 == 4:
        return {"road": 11, "driver": 1, "traffic": 2, "route": 0}
    if segment_id % 17 == 8:
        return {"road": 7, "driver": 0, "traffic": 1, "route": 1}
    if segment_id % 11 == 2:
        return {"road": 4, "driver": 2, "traffic": 3, "route": 0}
    if segment_id % 19 == 6:
        return {"road": 1, "driver": 5, "traffic": 1, "route": 2}
    return {"road": 0, "driver": 0, "traffic": 0, "route": 0}


def _road_level(road_events: int, total_events: int) -> str:
    if road_events >= 7 or total_events >= 10:
        return "red"
    if road_events >= 3 or total_events >= 5:
        return "yellow"
    return "green"


def build_ops_status() -> Dict[str, Any]:
    live_trips = list(TRIPS.values())
    base_trip = live_trips[-1] if live_trips else create_trip()
    live_counts: Dict[int, Dict[str, int]] = {}

    for trip in live_trips:
        for event in trip.events:
            bucket = event.attributed_to
            if bucket not in {"road", "driver", "traffic", "route"}:
                continue
            counts = live_counts.setdefault(
                event.segment_id,
                {"road": 0, "driver": 0, "traffic": 0, "route": 0},
            )
            counts[bucket] += 1

    has_live_events = any(sum(counts.values()) > 0 for counts in live_counts.values())
    rows: List[Dict[str, Any]] = []
    features: List[Dict[str, Any]] = []
    hotspots: List[Dict[str, Any]] = []

    for segment in base_trip.segments:
        counts = (
            live_counts.get(segment.id, {"road": 0, "driver": 0, "traffic": 0, "route": 0})
            if has_live_events
            else _demo_segment_counts(segment.id)
        )
        total_events = sum(counts.values())
        level = _road_level(counts["road"], total_events)
        status = {"green": "clear", "yellow": "watch", "red": "maintenance"}[level]
        confidence = min(96, 55 + counts["road"] * 5 + total_events * 2)
        reports = counts["road"] + max(0, counts["traffic"] // 2)
        rides_observed = max(len(live_trips), 6 + (segment.id % 5) * 3) if not has_live_events else max(1, len(live_trips))
        lat, lng = _midpoint(segment.coords)

        row = {
            "segment_id": segment.id,
            "status": status,
            "comfort": level,
            "road_events": counts["road"],
            "driver_events": counts["driver"],
            "traffic_events": counts["traffic"],
            "route_events": counts["route"],
            "reports": reports,
            "rides_observed": rides_observed,
            "confidence": confidence if total_events else 40,
            "length_m": round(segment.length_m, 1),
            "lat": round(lat, 6),
            "lng": round(lng, 6),
        }
        rows.append(row)
        features.append({
            "type": "Feature",
            "properties": {
                "id": segment.id,
                "comfort": level,
                "road_status": status,
                "road_events": counts["road"],
                "rides_observed": rides_observed,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": _coords_to_geojson(segment.coords),
            },
        })
        if status != "clear":
            hotspots.append({
                "id": f"ops-{segment.id}",
                "type": "road_status",
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "attributed_to": "road",
                "label": "Road maintenance watch" if status == "watch" else "Road maintenance priority",
                "icon": "🚧" if status == "watch" else "⚠️",
                "magnitude": counts["road"],
            })

    rows.sort(key=lambda r: (r["status"] != "maintenance", r["status"] != "watch", -r["road_events"]))
    status_counts = {
        "maintenance": sum(1 for row in rows if row["status"] == "maintenance"),
        "watch": sum(1 for row in rows if row["status"] == "watch"),
        "clear": sum(1 for row in rows if row["status"] == "clear"),
    }
    return {
        "source": "live" if has_live_events else "demo",
        "ride_count": len(live_trips) if has_live_events else 48,
        "segments": rows,
        "geojson": {"type": "FeatureCollection", "features": features},
        "hotspots": hotspots[:12],
        "summary": {
            "segments_tracked": len(rows),
            "maintenance": status_counts["maintenance"],
            "watch": status_counts["watch"],
            "clear": status_counts["clear"],
            "road_events": sum(row["road_events"] for row in rows),
            "driver_events": sum(row["driver_events"] for row in rows),
        },
    }


class StartBody(BaseModel):
    useFixture: bool = Field(default=True, alias="useFixture")


def create_app() -> FastAPI:
    app = FastAPI(title="Ride Comfort Intelligence API", version="2.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/map-style")
    async def map_style() -> dict:
        s = get_settings()
        if not s.grab_api_key.strip():
            raise HTTPException(503, "GRABMAPS_API_KEY not configured on server")
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{s.grab_base_url.rstrip('/')}/api/style.json",
                headers={"Authorization": f"Bearer {s.grab_api_key}"},
            )
            r.raise_for_status()
            return r.json()

    @app.get("/health")
    def health() -> dict:
        s = get_settings()
        return {
            "ok": True,
            "version": "2.0.0",
            "grab_configured": bool(s.grab_base_url.strip() and s.grab_api_key.strip()),
            "fixture": bool(s.use_directions_fixture),
        }

    @app.post("/trips")
    def start_trip(body: Optional[StartBody] = None) -> dict:
        if body is not None:
            os.environ["USE_DIRECTIONS_FIXTURE"] = "1" if body.useFixture else "0"
            get_settings.cache_clear()
        t = create_trip()
        TRIPS[t.id] = t
        return {
            "trip_id": t.id,
            "encoded_polyline": t.encoded_polyline,
            "path_lat_lng": [[p[0], p[1]] for p in t.points],
            "geojson": build_geojson(t),
            "baselines": [to_dict(b) for b in t.baselines],
            "segment_count": len(t.segments),
        }

    @app.get("/trips/{trip_id}")
    def get_trip(trip_id: str) -> dict:
        t = TRIPS.get(trip_id)
        if not t:
            raise HTTPException(404, "Unknown trip_id")
        return {
            "trip_id": t.id,
            "geojson": build_geojson(t),
            "segment_colors": segment_color_payload(t),
            "events": [e.to_dict() for e in t.events],
        }

    @app.get("/ops/road-status")
    def ops_road_status() -> dict:
        return build_ops_status()

    @app.post("/trips/{trip_id}/complete")
    def complete_trip(trip_id: str) -> dict:
        t = TRIPS.get(trip_id)
        if not t:
            raise HTTPException(404, "Unknown trip_id")
        result = final_score(t)
        result["trip_id"] = trip_id
        return result

    @app.websocket("/ws/trips/{trip_id}")
    async def trip_ws(websocket: WebSocket, trip_id: str) -> None:
        await websocket.accept()
        t = TRIPS.get(trip_id)
        if not t:
            await websocket.close(code=1008)
            return
        try:
            while True:
                msg = await websocket.receive_json()
                mtype = msg.get("type", "sample")

                if mtype == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue

                if mtype == "batch" and "items" in msg:
                    last: Optional[dict] = None
                    for item in msg["items"]:
                        last = on_sample(
                            t,
                            float(item.get("t_ms", 0)),
                            float(item["lat"]),
                            float(item["lng"]),
                            float(item.get("ax", 0)),
                            float(item.get("ay", 0)),
                            float(item.get("az", 9.81)),
                            float(item.get("speed_kmh", 0)),
                        )
                    if last is not None:
                        await websocket.send_json({
                            **last,
                            "segment_colors": segment_color_payload(t),
                            "segment_geojson": build_geojson(t),
                        })
                else:
                    state = on_sample(
                        t,
                        float(msg.get("t_ms", 0)),
                        float(msg["lat"]),
                        float(msg["lng"]),
                        float(msg.get("ax", 0)),
                        float(msg.get("ay", 0)),
                        float(msg.get("az", 9.81)),
                        float(msg.get("speed_kmh", 0)),
                    )
                    await websocket.send_json({
                        **state,
                        "segment_colors": segment_color_payload(t),
                        "segment_geojson": build_geojson(t),
                    })

        except WebSocketDisconnect:
            return

    return app


app = create_app()
