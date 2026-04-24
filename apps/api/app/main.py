from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

from app.baseline import to_dict
from app.config import get_settings
from app.trip_state import (
    create_trip,
    final_score,
    on_sample,
    segment_color_payload,
    Trip,
)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

TRIPS: Dict[str, Trip] = {}


def _line_coords_wgs84_to_geojson(pts: List[Tuple[float, float]]) -> List[List[float]]:
    return [[p[1], p[0]] for p in pts]


def build_geojson(trip: Trip) -> Dict[str, Any]:
    feats: List[Dict[str, Any]] = []
    for s in trip.segments:
        level = trip.segment_comfort.get(s.id, "green")
        feats.append(
            {
                "type": "Feature",
                "properties": {"id": s.id, "comfort": level},
                "geometry": {
                    "type": "LineString",
                    "coordinates": _line_coords_wgs84_to_geojson(s.coords),
                },
            }
        )
    return {"type": "FeatureCollection", "features": feats}


class StartBody(BaseModel):
    useFixture: bool = Field(default=True, alias="useFixture")


def create_app() -> FastAPI:
    app = FastAPI(title="Ride comfort API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict:
        s = get_settings()
        return {
            "ok": True,
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
        bdict = [to_dict(b) for b in t.baselines]
        return {
            "trip_id": t.id,
            "encoded_polyline": t.encoded_polyline,
            "path_lat_lng": [[p[0], p[1]] for p in t.points],
            "geojson": build_geojson(t),
            "baselines": bdict,
            "segment_count": len(t.segments),
        }

    @app.post("/trips/{trip_id}/complete")
    def complete_trip(trip_id: str) -> dict:
        t = TRIPS.get(trip_id)
        if not t:
            raise HTTPException(404, "Unknown trip_id")
        res = final_score(t)
        res["trip_id"] = trip_id
        return res

    @app.get("/trips/{trip_id}")
    def get_trip(trip_id: str) -> dict:
        t = TRIPS.get(trip_id)
        if not t:
            raise HTTPException(404, "Unknown trip_id")
        return {
            "trip_id": t.id,
            "encoded_polyline": t.encoded_polyline,
            "geojson": build_geojson(t),
            "segment_states": segment_color_payload(t),
        }

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
                if mtype in ("sample", "batch"):
                    if mtype == "batch" and "items" in msg:
                        last: Optional[dict] = None
                        for it in msg["items"]:
                            last = on_sample(
                                t,
                                float(it.get("t_ms", 0)),
                                float(it["lat"]),
                                float(it["lng"]),
                                float(it.get("ax", 0)),
                                float(it.get("ay", 0)),
                                float(it.get("az", 0)),
                            )
                        if last is not None:
                            await websocket.send_json(
                                {
                                    **last,
                                    "segment_colors": segment_color_payload(t),
                                    "segment_geojson": build_geojson(t),
                                }
                            )
                    else:
                        st = on_sample(
                            t,
                            float(msg.get("t_ms", 0)),
                            float(msg["lat"]),
                            float(msg["lng"]),
                            float(msg.get("ax", 0)),
                            float(msg.get("ay", 0)),
                            float(msg.get("az", 0)),
                        )
                        await websocket.send_json(
                            {
                                **st,
                                "segment_colors": segment_color_payload(t),
                                "segment_geojson": build_geojson(t),
                            }
                        )
        except WebSocketDisconnect:
            return

    return app


app = create_app()
