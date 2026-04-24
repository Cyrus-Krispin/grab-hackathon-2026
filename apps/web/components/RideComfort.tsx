"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ComfortMap, type CurrentPosition, type PlanPin, type RideEvent, type SegmentGeo } from "./ComfortMap";
import { SingaporePlaceField, type PickedPlace } from "./SingaporePlaceField";
import { getApiUrl, tripWsUrl } from "@/lib/config";

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "idle" | "running" | "done";
type Comfort = "green" | "yellow" | "red";

type LiveState = {
  comfort: Comfort;
  current_segment: number;
  segment_count: number;
  position: CurrentPosition;
  metrics: {
    lateral_mps2: number;
    brake_mps2: number;
    jerk_mps3: number;
    speed_kmh: number;
  };
};

type FinalResult = {
  score: number;
  summary: string;
  attribution: Record<string, number>;
  coaching: string[];
  events: RideEvent[];
  stats: { total_events: number; red_segments: number; yellow_segments: number; green_segments: number };
};

// ─── Constants ────────────────────────────────────────────────────────────────

const emptyFc: SegmentGeo = { type: "FeatureCollection", features: [] };

const COMFORT_COLORS: Record<Comfort, string> = {
  green:  "#00b14f",
  yellow: "#f59e0b",
  red:    "#ef4444",
};

const COMFORT_LABELS: Record<Comfort, string> = {
  green:  "Smooth",
  yellow: "Bumpy",
  red:    "Rough",
};

const ATTR_COLORS: Record<string, string> = {
  driver:  "#60a5fa",
  road:    "#f97316",
  traffic: "#a78bfa",
  route:   "#34d399",
};

// ─── Simulator (per-trip random incidents) ────────────────────────────────────

function hashTripSeed(tripId: string): number {
  let h = 2166136261;
  for (let i = 0; i < tripId.length; i++) {
    h ^= tripId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function runtimeNonce32(): number {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0];
  }
  return (Date.now() ^ Math.floor((globalThis.performance?.now() ?? 0) * 1e6)) >>> 0;
}

/** Deterministic per trip_id so each booking differs; XOR browser entropy so rapid re-runs still vary. */
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

type Sample = {
  lat: number;
  lng: number;
  ax: number;
  ay: number;
  az: number;
  speed_kmh: number;
};

type IncidentApply = (s: Sample, ctx: { naturalLateral: number; rng: () => number }) => void;

const INCIDENT_LIBRARY: IncidentApply[] = [
  // Harsh brake — mostly longitudinal (traffic-style)
  (s, { rng }) => {
    s.ax = -5.0 + (rng() - 0.5) * 0.9;
    s.ay = 0.15 + rng() * 0.35;
    s.spd = Math.max(12, 22 - rng() * 10);
  },
  // Vertical bump
  (s, { rng }) => {
    s.az = 13.6 + rng() * 2.4;
  },
  // Hard acceleration
  (s, { rng }) => {
    s.ax = 4.4 + rng() * 1.1;
    s.spd = 68 + rng() * 14;
  },
  // Brake + lateral (swerve)
  (s, { rng }) => {
    s.ax = -4.0 - rng() * 1.2;
    s.ay = 3.2 + rng() * 1.2;
    s.spd = 28 + rng() * 18;
  },
  // Second bump profile
  (s, { rng }) => {
    s.az = 12.9 + rng() * 2.2;
  },
  // Speeding with turn
  (s, { naturalLateral, rng }) => {
    s.spd = 88 + rng() * 16;
    s.ay = Math.max(2.2, Math.abs(naturalLateral) * 0.9 + rng() * 1.4);
  },
];

/** Pick indices along the polyline with margin from ends and spacing between incidents. */
function pickIncidentIndices(n: number, count: number, rng: () => number): number[] {
  if (n < 4 || count < 1) return [];

  const margin = Math.max(1, Math.min(Math.floor(n * 0.05), 20));
  const minGap = Math.max(1, Math.floor(n * 0.025));
  const lo = margin;
  const hi = n - 1 - margin;
  if (hi <= lo) return [Math.floor((lo + hi) / 2)];

  const pool: number[] = [];
  for (let i = lo; i <= hi; i++) pool.push(i);
  shuffleInPlace(pool, rng);

  const picked: number[] = [];
  for (const idx of pool) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p - idx) >= minGap)) picked.push(idx);
  }

  if (picked.length < count) {
    for (let i = lo; i <= hi && picked.length < count; i++) {
      if (picked.every((p) => Math.abs(p - i) >= Math.max(1, minGap - 1))) picked.push(i);
    }
  }
  return picked.slice(0, count);
}

function buildIncidentPlan(n: number, tripId: string): Map<number, IncidentApply> {
  const rng = mulberry32(hashTripSeed(tripId) ^ runtimeNonce32());

  const count = Math.min(INCIDENT_LIBRARY.length + 1, Math.max(3, Math.floor(n / 28)));
  const indices = pickIncidentIndices(n, count, rng);
  const recipes = [...INCIDENT_LIBRARY];
  shuffleInPlace(recipes, rng);

  const map = new Map<number, IncidentApply>();
  for (let k = 0; k < indices.length; k++) {
    map.set(indices[k], recipes[k % recipes.length]);
  }
  return map;
}

/**
 * Motion stream from the route path: baseline noise + curvature-based lateral,
 * plus incidents placed at trip-unique indices with shuffled types and jittered magnitudes.
 */
function buildSamples(path: [number, number][], tripId: string): Sample[] {
  const n = path.length;
  const incidents = buildIncidentPlan(n, tripId);
  const rng = mulberry32(hashTripSeed(tripId) ^ 0x9e3779b9);

  return path.map(([lat, lng], i) => {
    const progress = i / Math.max(n - 1, 1);

    let spd = 55;
    if (progress < 0.15) spd = 30 + (progress / 0.15) * 25;
    else if (progress > 0.85) spd = 55 - ((progress - 0.85) / 0.15) * 25;

    let naturalLateral = 0;
    if (i > 0 && i < n - 1) {
      const [la0, lo0] = path[i - 1];
      const [la1, lo1] = path[i];
      const [la2, lo2] = path[i + 1];
      const b0 = Math.atan2(lo1 - lo0, la1 - la0);
      const b1 = Math.atan2(lo2 - lo1, la2 - la1);
      const delta = b1 - b0;
      naturalLateral = Math.sin(delta) * 1.8;
    }

    const ax = 0.25 + (rng() - 0.5) * 0.15;
    const ay = naturalLateral + (rng() - 0.5) * 0.18;
    const az = 9.81 + (rng() - 0.5) * 0.12;

    const sample: Sample = { lat, lng, ax, ay, az, speed_kmh: spd };
    const inject = incidents.get(i);
    if (inject) inject(sample, { naturalLateral, rng });

    return sample;
  });
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function RideComfort() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [geojson, setGeojson] = useState<SegmentGeo>(emptyFc);
  const [events, setEvents] = useState<RideEvent[]>([]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [result, setResult] = useState<FinalResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const [startPlace, setStartPlace] = useState<PickedPlace | null>(null);
  const [endPlace, setEndPlace] = useState<PickedPlace | null>(null);
  const [useDemoRoute, setUseDemoRoute] = useState(false);
  const [routingNote, setRoutingNote] = useState<string | null>(null);

  const tripIdRef = useRef<string | null>(null);
  const wsRef     = useRef<WebSocket | null>(null);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const samplesRef = useRef<ReturnType<typeof buildSamples>>([]);
  const idxRef    = useRef(0);
  const t0Ref     = useRef(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  // ── Step 1: Book trip ──────────────────────────────────────────────────────
  const startTrip = useCallback(async () => {
    setErr(null); setResult(null); setEvents([]); setLive(null);
    setGeojson(emptyFc); setPhase("idle"); setWsReady(false);
    setRoutingNote(null);

    if (!useDemoRoute && (!startPlace || !endPlace)) {
      setErr("Select a start and end place in Singapore, or turn on “Demo route”.");
      return;
    }

    try {
      const body: Record<string, unknown> = useDemoRoute
        ? { useFixture: true }
        : {
            useFixture: false,
            origin: { lat: startPlace!.lat, lng: startPlace!.lng },
            destination: { lat: endPlace!.lat, lng: endPlace!.lng },
          };

      const res = await fetch(`${getApiUrl()}/trips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

      const d = await res.json() as {
        trip_id: string;
        geojson: SegmentGeo;
        path_lat_lng: [number, number][];
        routing_mode?: string;
      };

      if (d.routing_mode === "grab") setRoutingNote(null);
      else if (d.routing_mode === "osrm") {
        setRoutingNote("Route from OSRM. Add GRABMAPS_API_KEY for Grab Directions.");
      } else if (useDemoRoute) {
        setRoutingNote("Built-in demo path (not tied to map search).");
      } else {
        setRoutingNote("Sample route geometry. Set GRABMAPS_API_KEY for Grab between your places.");
      }

      tripIdRef.current = d.trip_id;
      setGeojson(d.geojson);
      samplesRef.current = buildSamples(d.path_lat_lng || [], d.trip_id);
      idxRef.current = 0;
      t0Ref.current = performance.now();

      // Open WebSocket
      const ws = new WebSocket(tripWsUrl(d.trip_id));
      ws.onopen = () => setWsReady(true);
      ws.onclose = () => setWsReady(false);
      ws.onerror = () => setErr("WebSocket error — is the API running?");
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "state") {
            setLive({
              comfort: msg.comfort,
              current_segment: msg.current_segment,
              segment_count: msg.segment_count,
              position: msg.position,
              metrics: msg.metrics,
            });
            if (msg.segment_geojson) setGeojson(msg.segment_geojson);
            if (msg.new_events?.length) {
              setEvents((prev) => [...prev, ...msg.new_events]);
            }
          }
        } catch { /* ignore parse errors */ }
      };
      wsRef.current = ws;
      setPhase("running");
    } catch (e) {
      setErr(`Failed to start trip: ${e instanceof Error ? e.message : e}`);
    }
  }, [useDemoRoute, startPlace, endPlace]);

  // ── Step 2: Run simulator ──────────────────────────────────────────────────
  const runSimulator = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setErr("WebSocket not open yet — wait a moment after booking.");
      return;
    }
    setErr(null);
    idxRef.current = 0;
    t0Ref.current = performance.now();

    timerRef.current = setInterval(() => {
      const samples = samplesRef.current;
      if (!samples.length) return;
      const idx = idxRef.current;
      if (idx >= samples.length) {
        stopTimer();
        return;
      }
      const s = samples[idx];
      idxRef.current = idx + 1;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "sample",
          t_ms: performance.now() - t0Ref.current,
          lat: s.lat,
          lng: s.lng,
          ax: s.ax,
          ay: s.ay,
          az: s.az,
          speed_kmh: s.speed_kmh,
        }));
      }
    }, 120);
  }, [stopTimer]);

  // Auto-run simulator once WS is open
  useEffect(() => {
    if (wsReady && phase === "running" && idxRef.current === 0 && !timerRef.current) {
      runSimulator();
    }
  }, [wsReady, phase, runSimulator]);

  // ── Step 3: Complete trip ──────────────────────────────────────────────────
  const endTrip = useCallback(async () => {
    stopTimer();
    wsRef.current?.close();
    const id = tripIdRef.current;
    if (!id) return;
    try {
      const res = await fetch(`${getApiUrl()}/trips/${id}/complete`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
      const r = await res.json() as FinalResult;
      setResult(r);
      if (r.events?.length) setEvents(r.events);
      setPhase("done");
    } catch (e) {
      setErr(`Complete failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [stopTimer]);

  // Auto-complete when simulator finishes all samples
  useEffect(() => {
    if (phase !== "running" || timerRef.current) return;
    if (!samplesRef.current.length) return;
    if (idxRef.current >= samplesRef.current.length && idxRef.current > 0) {
      setTimeout(endTrip, 600);
    }
  });

  const comfort = live?.comfort ?? "green";

  const pickPins: PlanPin[] | null =
    phase === "idle" && startPlace && endPlace && !useDemoRoute
      ? [
          { role: "start", lat: startPlace.lat, lng: startPlace.lng },
          { role: "end", lat: endPlace.lat, lng: endPlace.lng },
        ]
      : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-950">
      <ComfortMap
        geojson={geojson}
        events={events}
        currentPosition={live?.position}
        pickPins={pickPins}
      />

      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="absolute left-4 top-4 rounded-lg border border-zinc-200 bg-white/95 px-4 py-3 shadow-xl backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold" style={{ color: "#00b14f" }}>Grab</span>
                <span className="text-sm font-medium text-zinc-800">Comfort Intelligence</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                <span className={`h-1.5 w-1.5 rounded-full ${wsReady ? "bg-green-500" : "bg-zinc-600"}`} />
                {phase === "running"
                  ? wsReady ? "Connected · simulating" : "Connecting..."
                  : phase === "done" ? "Trip complete" : "Ready"}
              </div>
              {routingNote && phase === "running" && (
                <p className="mt-2 max-w-[220px] text-[11px] leading-snug text-amber-700">{routingNote}</p>
              )}
            </div>
            <Link
              href="/analytics"
              className="pointer-events-auto rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              Ops
            </Link>
          </div>
        </div>

        {phase === "running" && live && (
          <div className="absolute left-4 top-24 flex items-center gap-2 rounded-full border border-zinc-200 bg-white/95 px-4 py-2 shadow-xl backdrop-blur">
            <span
              className={`h-3 w-3 rounded-full pulse-${comfort}`}
              style={{ background: COMFORT_COLORS[comfort] }}
            />
            <span className="text-sm font-semibold" style={{ color: COMFORT_COLORS[comfort] }}>
              {COMFORT_LABELS[comfort]}
            </span>
            <span className="ml-1 text-xs text-zinc-500">
              seg {(live.current_segment ?? 0) + 1}/{live.segment_count ?? "-"}
            </span>
          </div>
        )}

        <div className="absolute bottom-6 left-4 flex gap-3 rounded-lg border border-zinc-200 bg-white/90 px-3 py-2 text-xs text-zinc-600 shadow-xl backdrop-blur">
          {(["green","yellow","red"] as Comfort[]).map((c) => (
            <span key={c} className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-3 rounded-full" style={{ background: COMFORT_COLORS[c] }} />
              {COMFORT_LABELS[c]}
            </span>
          ))}
        </div>

        <div className="pointer-events-auto absolute bottom-4 left-4 right-4 flex max-h-[72vh] flex-col overflow-y-auto rounded-lg border border-zinc-200 bg-white/95 p-4 shadow-2xl backdrop-blur md:bottom-4 md:left-auto md:top-4 md:w-80 md:max-h-none">
          {/* ── Idle: pre-trip ────────────────────────────────────────── */}
          {phase === "idle" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-4 text-sm leading-relaxed text-zinc-600">
                <p className="text-zinc-800 font-medium mb-1">How it works</p>
                <p>Search any start and end in Singapore, then run a comfort simulation along the driving route. Events are attributed to <span className="text-blue-600">driver</span>, <span className="text-orange-600">road</span>, <span className="text-purple-600">traffic</span>, or <span className="text-emerald-600">route</span>.</p>
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-zinc-300"
                  checked={useDemoRoute}
                  onChange={(e) => {
                    setUseDemoRoute(e.target.checked);
                    if (e.target.checked) {
                      setStartPlace(null);
                      setEndPlace(null);
                    }
                  }}
                />
                <span>
                  <span className="font-medium text-zinc-800">Demo route</span>
                  <span className="block text-zinc-500">Use the built-in sample path (no place search).</span>
                </span>
              </label>

              {!useDemoRoute && (
                <div className="flex flex-col gap-3">
                  <SingaporePlaceField label="From" value={startPlace} onChange={setStartPlace} />
                  <SingaporePlaceField label="To" value={endPlace} onChange={setEndPlace} />
                </div>
              )}

              <button
                onClick={startTrip}
                disabled={!useDemoRoute && (!startPlace || !endPlace)}
                className="w-full rounded-lg py-3 text-sm font-semibold text-white transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "#00b14f" }}
              >
                Book &amp; Start Trip
              </button>
            </div>
          )}

          {/* ── Running: live metrics ─────────────────────────────────── */}
          {phase === "running" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Lateral G" value={`${(live?.metrics.lateral_mps2 ?? 0).toFixed(2)}`} unit="m/s²" />
                <Metric label="Braking G" value={`${(live?.metrics.brake_mps2 ?? 0).toFixed(2)}`} unit="m/s²" />
                <Metric label="Jerk" value={`${(live?.metrics.jerk_mps3 ?? 0).toFixed(1)}`} unit="m/s³" />
                <Metric label="Speed" value={`${(live?.metrics.speed_kmh ?? 0).toFixed(0)}`} unit="km/h" />
              </div>

              {events.length > 0 && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-3">
                  <p className="text-xs font-medium text-zinc-600 mb-2">Detected Events</p>
                  <ul className="flex flex-col gap-1.5">
                    {events.slice(-5).reverse().map((ev) => (
                      <li key={ev.id} className="flex items-center gap-2 text-xs">
                        <span>{ev.icon}</span>
                        <span className="text-zinc-700 flex-1">{ev.label}</span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: ATTR_COLORS[ev.attributed_to] + "22",
                            color: ATTR_COLORS[ev.attributed_to],
                          }}
                        >
                          {ev.attributed_to}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                onClick={endTrip}
                className="w-full rounded-lg border border-zinc-300 bg-white py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
              >
                End Trip &amp; Score
              </button>
            </>
          )}

          {/* ── Done: score card ──────────────────────────────────────── */}
          {phase === "done" && result && (
            <div className="flex flex-col gap-4">
              {/* Score */}
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-5 text-center">
                <p className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Comfort Score</p>
                <p
                  className="text-5xl font-bold leading-none"
                  style={{
                    color:
                      result.score >= 80 ? "#00b14f"
                      : result.score >= 60 ? "#f59e0b"
                      : "#ef4444",
                  }}
                >
                  {result.score.toFixed(1)}
                </p>
                <p className="mt-2 text-xs text-zinc-500">out of 100</p>
                <p className="mt-4 text-sm leading-snug text-zinc-700">{result.summary}</p>
              </div>

              {/* Stats strip */}
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                <div className="rounded-lg bg-zinc-50/95 border border-zinc-200 p-3">
                  <p className="text-zinc-800 font-bold text-lg" style={{ color: "#00b14f" }}>{result.stats.green_segments}</p>
                  <p className="text-zinc-500">Smooth</p>
                </div>
                <div className="rounded-lg bg-zinc-50/95 border border-zinc-200 p-3">
                  <p className="text-zinc-800 font-bold text-lg" style={{ color: "#f59e0b" }}>{result.stats.yellow_segments}</p>
                  <p className="text-zinc-500">Bumpy</p>
                </div>
                <div className="rounded-lg bg-zinc-50/95 border border-zinc-200 p-3">
                  <p className="text-zinc-800 font-bold text-lg" style={{ color: "#ef4444" }}>{result.stats.red_segments}</p>
                  <p className="text-zinc-500">Rough</p>
                </div>
              </div>

              {/* Attribution */}
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-4">
                <p className="mb-3 text-xs font-medium text-zinc-600">Discomfort Attribution</p>
                <div className="flex flex-col gap-2.5">
                  {Object.entries(result.attribution)
                    .filter(([, v]) => v > 0)
                    .sort(([, a], [, b]) => b - a)
                    .map(([key, pct]) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-xs w-14 text-zinc-600 capitalize">{key}</span>
                        <div className="flex-1 h-2 rounded-full bg-zinc-200 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, background: ATTR_COLORS[key] ?? "#71717a" }}
                          />
                        </div>
                        <span className="text-xs text-zinc-600 w-8 text-right">{pct}%</span>
                      </div>
                    ))}
                </div>
              </div>

              {/* Driver coaching */}
              {result.coaching.length > 0 && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/95 p-4">
                  <p className="mb-3 text-xs font-medium text-blue-700">Driver Coaching</p>
                  <ul className="flex flex-col gap-2">
                    {result.coaching.map((hint, i) => (
                      <li key={i} className="text-xs text-zinc-700 flex gap-1.5">
                        <span className="text-blue-700 mt-0.5">›</span>
                        {hint}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* All events */}
              {result.events.length > 0 && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-4">
                  <p className="mb-3 text-xs font-medium text-zinc-600">
                    All Events ({result.events.length})
                  </p>
                  <ul className="flex max-h-40 flex-col gap-2 overflow-y-auto">
                    {result.events.map((ev) => (
                      <li key={ev.id} className="flex items-center gap-2 text-xs">
                        <span>{ev.icon}</span>
                        <span className="text-zinc-700 flex-1">{ev.label}</span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: ATTR_COLORS[ev.attributed_to] + "22",
                            color: ATTR_COLORS[ev.attributed_to],
                          }}
                        >
                          {ev.attributed_to}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                onClick={startTrip}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white py-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
              >
                New Trip
              </button>
            </div>
          )}

          {/* Error */}
          {err && (
            <div className="rounded-lg border border-red-200 bg-red-50/95 p-3 text-xs text-red-700">
              {err}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Metric tile ──────────────────────────────────────────────────────────────

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-lg bg-zinc-50/95 border border-zinc-200 p-2.5">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-lg font-bold text-zinc-900 leading-tight">
        {value} <span className="text-xs font-normal text-zinc-500">{unit}</span>
      </p>
    </div>
  );
}
