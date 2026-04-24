# GrabRide Comfort Intelligence

A route-aware comfort and safety intelligence layer for Grab rides. Motion data from the driver's phone — accelerometer, gyroscope, GPS — is mapped to individual road segments in real time. Events like harsh braking, sharp turns, and bumps are detected and attributed to one of four causes: driver behaviour, road surface, traffic conditions, or route geometry. Riders get a transparent post-trip summary, drivers get fair coaching, and Grab gets a city-wide signal for road quality.

---

## The Problem

Ride comfort today is a black box. A passenger might give a low rating after a bumpy trip even if the driver did nothing wrong — the road was just bad. Drivers get penalised unfairly. Grab has no systematic way to tell the difference between a rough driver and a rough road.

---

## The Solution

Every ride produces a stream of phone sensor data. This system maps that stream onto the reference route, computes per-segment comfort bands calibrated to that road's expected geometry and speed, detects anomalous events, and attributes each event to its likely cause.

### Four Attribution Buckets

| Attribution | What it means | Example |
|---|---|---|
| **Driver** | Driving behaviour caused the discomfort | Hard acceleration, swerving while braking |
| **Road** | Surface condition caused the discomfort | Pothole, speed bump |
| **Traffic** | Traffic flow caused the discomfort | Emergency stop behind a slowing car |
| **Route** | Road geometry is inherently demanding | Tight bend requiring high lateral G |

### Five Detected Event Types

| Event | Trigger | Default attribution |
|---|---|---|
| `harsh_brake` | Longitudinal decel > 3.5 m/s² | Traffic (straight road) or Driver (with lateral) |
| `harsh_accel` | Longitudinal accel > 3.5 m/s² | Driver |
| `sharp_turn` | Lateral accel > 3.0 m/s² | Route (high curvature) or Driver (straight road) |
| `bump` | Vertical spike \|az − 9.81\| > 2.8 m/s² | Road |
| `speeding_risky` | Speed > limit + 15 km/h and lateral > 1.5 m/s² | Driver |

---

## How It Works

```
Book ride
   │
   ▼
GET /api/v1/maps/eta/v1/direction  ← Grab Maps Directions API
   │  Returns encoded polyline for the route
   ▼
Segment polyline into ~55 m chunks
   │  Split at target length or bearing change > 22°
   ▼
Compute per-segment baseline
   │  Curvature → speed limit proxy, lateral/jerk/brake thresholds
   ▼
Trip starts — phone streams motion samples via WebSocket
   │  { lat, lng, ax, ay, az, speed_kmh } at ~8 Hz
   ▼
Map-match each sample to nearest segment
   │  Equirectangular projection, point-to-edge distance
   ▼
Detect events against segment baseline
   │  Cooldown per (event_type, segment) to avoid duplicate firing
   ▼
Attribute each event → driver / road / traffic / route
   │  Based on curvature of the matched segment + lateral force
   ▼
Update segment comfort level: green → yellow → red
   │  Worst level seen on segment persists
   ▼
Push live state to frontend via WebSocket
   │  { comfort, metrics, new_events, segment_geojson }
   ▼
Trip complete → POST /trips/{id}/complete
   │
   ▼
Final score (0–100) + summary + attribution % + driver coaching
```

---

## Comfort Score

```
score = 100 − (20 × red_segments/total) − (7 × yellow_segments/total)
```

Clamped to [0, 100]. The score reflects how much of the route experienced rough conditions, weighted by severity.

---

## Architecture

```
grab-hackathon-2026/
├── apps/
│   ├── api/                         FastAPI backend (Python)
│   │   └── app/
│   │       ├── main.py              API routes + WebSocket
│   │       ├── config.py            Settings (reads .env)
│   │       ├── grab/
│   │       │   ├── client.py        Grab Directions API + fixture loader
│   │       │   ├── polyline.py      Polyline precision-6 decoder
│   │       │   └── fixtures/        Canned Singapore route (dev)
│   │       └── comfort/
│   │           ├── segmentation.py  Polyline → segments (length + curvature)
│   │           ├── geometry.py      Nearest-segment map matching
│   │           ├── baseline.py      Per-segment comfort thresholds
│   │           ├── events.py        Event types, attribution logic
│   │           └── trip.py          Live scoring, final report
│   └── web/                         Next.js frontend (TypeScript)
│       ├── app/                     App Router pages + layout
│       ├── components/
│       │   ├── ComfortMap.tsx       MapLibre map, segment colours, event markers
│       │   └── RideComfort.tsx      Trip lifecycle UI + live metrics panel
│       └── lib/
│           └── config.ts            API URL helpers
├── SKILL.md                         Grab Maps API reference (from organizers)
└── .env.example                     Environment variable template
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service status |
| `GET` | `/map-style` | Proxies `https://maps.grab.com/api/style.json` with server-side Bearer auth |
| `POST` | `/trips` | Create trip: fetch route, segment, compute baselines |
| `GET` | `/trips/{id}` | Current trip state (geojson + events) |
| `WS` | `/ws/trips/{id}` | Real-time motion sample ingestion + event stream |
| `POST` | `/trips/{id}/complete` | Final score, attribution breakdown, coaching |

### WebSocket Sample (client → server)

```json
{
  "type": "sample",
  "t_ms": 4210,
  "lat": 1.3155,
  "lng": 103.8425,
  "ax": -4.8,
  "ay": 0.3,
  "az": 9.9,
  "speed_kmh": 52
}
```

### WebSocket State (server → client)

```json
{
  "type": "state",
  "current_segment": 7,
  "segment_count": 36,
  "comfort": "red",
  "metrics": { "lateral_mps2": 0.3, "brake_mps2": 4.8, "jerk_mps3": -12.1, "speed_kmh": 52 },
  "new_events": [
    { "type": "harsh_brake", "attributed_to": "driver", "label": "Sudden braking", "icon": "🛑", "lat": 1.3155, "lng": 103.8425 }
  ],
  "segment_geojson": { "...": "updated feature collection with comfort colours" }
}
```

### Complete Trip Response

```json
{
  "score": 74.3,
  "summary": "2 segment(s) had rough moments. Most discomfort came from driving style.",
  "attribution": { "driver": 50, "road": 33, "traffic": 17, "route": 0 },
  "coaching": [
    "Anticipate stops earlier to reduce harsh braking.",
    "Smooth acceleration improves the ride experience."
  ],
  "events": [ "..." ],
  "stats": { "total_events": 6, "red_segments": 2, "yellow_segments": 4, "green_segments": 30 }
}
```

---

## Running Locally

### Prerequisites

- Python 3.11+ with [uv](https://github.com/astral-sh/uv)
- Node.js 20+

### Setup

```bash
cp .env.example .env
# Set GRABMAPS_API_KEY to your bm_… key
# Set USE_DIRECTIONS_FIXTURE=1 to skip the live directions call during dev
```

```bash
# Copy NEXT_PUBLIC_ vars so Next.js picks them up
grep "^NEXT_PUBLIC_" .env > apps/web/.env.local
```

### Start

```bash
# Terminal 1 — API (port 8000)
cd apps/api && uv sync && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Terminal 2 — Web (port 3000)
cd apps/web && npm install && npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `GRABMAPS_API_KEY` | Backend | Bearer key for Directions API + map style proxy |
| `GRABMAPS_BASE_URL` | Backend | API gateway root (default `https://maps.grab.com`) |
| `USE_DIRECTIONS_FIXTURE` | Backend | `1` = use canned route, `0` = call live Directions API |
| `NEXT_PUBLIC_API_URL` | Frontend | Backend base URL (default `http://127.0.0.1:8000`) |
| `NEXT_PUBLIC_WS_URL` | Frontend | WebSocket base URL (default `ws://127.0.0.1:8000`) |

The GrabMaps API key is **never sent to the browser**. The frontend fetches the map style from `GET /map-style` on the backend, which proxies the Grab API call server-side.

---

## What's Simulated vs. What's Real

| Component | Status |
|---|---|
| Grab Maps tile rendering | ✅ Real (GrabMaps API) |
| Route from Directions API | ✅ Real (fixture toggle for dev) |
| Polyline segmentation | ✅ Real algorithm |
| Per-segment comfort baseline | ✅ Real (curvature-derived) |
| Motion data (ax, ay, az) | 🔵 Simulated in browser — replace with phone SDK |
| Map matching | ✅ Real (equirectangular nearest-edge) |
| Event detection + attribution | ✅ Real algorithm |
| Comfort score | ✅ Real |
| City-wide road heatmap | 🔵 Requires trip aggregation across many rides |
