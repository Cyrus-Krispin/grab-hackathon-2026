# Ride comfort (Grab Maps + Next.js + FastAPI)

Monorepo: **Next.js** map + WebSocket client, **FastAPI** for Grab `directions`, per-segment comfort baselines, and live scoring.

## Prerequisites

- Node.js 20+
- Python 3.11+ with [uv](https://github.com/astral-sh/uv) (or use `pip` in `apps/api`)

## Environment

**Authoritative API notes** (auth header, `lng,lat` for `direction`, style URL) are in [`SKILL.md`](SKILL.md) (Grab Maps library + gateway).

1. Copy `.env.example` to `.env` in the project root and set:
   - `GRABMAPS_API_KEY` and `NEXT_PUBLIC_GRABMAPS_API_KEY` (same `bm_…` key is fine for the hackathon)
   - `GRABMAPS_BASE_URL` and `NEXT_PUBLIC_GRABMAPS_BASE_URL` — default is `https://maps.grab.com` (no trailing slash)
2. `USE_DIRECTIONS_FIXTURE=1` forces the canned Singapore polyline; without it, a key calls live **`GET /api/v1/maps/eta/v1/direction`** on the configured base.

## Run (two terminals)

From repo root, create `.env` (see `.env.example`). You can `cp .env apps/web/.env.local` if Next.js should pick it up, or set variables in the shell.

**API** (port 8000) — with `uv` (recommended):

```bash
cd apps/api && uv sync && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**API** (without `uv`) — use a venv and `requirements.txt`:

```bash
cd apps/api && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && \
  USE_DIRECTIONS_FIXTURE=1 PYTHONPATH=. uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**Web** (port 3000):

```bash
npm install
npm run dev:web
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## Demo route (Singapore, fixed in API)

The backend uses a fixed O/D; trip start fetches `maps/eta/v1/direction` (driving) or a fixture, then segments the polyline for comfort bands.

## Plan reference

The implementation follows the “Ride comfort + Grab Maps” monorego plan: WebSocket “in range” updates, per-segment green/yellow/red, end-of-trip score.
