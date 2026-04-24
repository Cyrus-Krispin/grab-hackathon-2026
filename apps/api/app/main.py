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
