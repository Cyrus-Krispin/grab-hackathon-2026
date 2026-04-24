"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** Route-curvature proxy for posted limit on current segment (km/h). */
  speed_limit_kmh: number | null;
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
  event_counts: Record<string, number>;
  events: RideEvent[];
  stats: { total_events: number; red_segments: number; yellow_segments: number; green_segments: number };
};

type StreamRow = {
  t_ms: number;
  lat: number;
  lng: number;
  comfort: Comfort;
  lateral_mps2: number;
  brake_mps2: number;
  jerk_mps3: number;
  speed_kmh: number;
};

const STREAM_TONE: Record<Comfort, { line: string; chip: string }> = {
  green:  { line: "border-l-4 border-l-emerald-500 bg-emerald-50/90", chip: "bg-emerald-600 text-white" },
  yellow: { line: "border-l-4 border-l-amber-500 bg-amber-50/90", chip: "bg-amber-500 text-white" },
  red:    { line: "border-l-4 border-l-red-500 bg-red-50/90", chip: "bg-red-600 text-white" },
};

// ─── Constants ────────────────────────────────────────────────────────────────

const emptyFc: SegmentGeo = { type: "FeatureCollection", features: [] };

const CONTEXT_COLORS: Record<string, string> = {
  vehicle: "#60a5fa",
  road:    "#f97316",
  traffic: "#a78bfa",
  route:   "#34d399",
};

const CONTEXT_LABELS: Record<string, string> = {
  vehicle: "Motion",
  traffic: "Traffic",
  road:    "Road",
  route:   "Route",
};

/** Display order for post-trip event breakdown */
const EVENT_BREAKDOWN_ORDER: string[] = [
  "speeding",
  "speeding_risky",
  "uneven_accel",
  "harsh_accel",
  "harsh_brake",
  "sharp_turn",
  "bump",
];

const EVENT_TYPE_LABELS: Record<string, string> = {
  speeding: "Over speed limit",
  speeding_risky: "High speed while turning",
  uneven_accel: "Uneven acceleration",
  harsh_accel: "Hard acceleration",
  harsh_brake: "Sudden braking",
  sharp_turn: "Sharp lateral movement",
  bump: "Road bump",
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
    s.speed_kmh = Math.max(12, 22 - rng() * 10);
  },
  // Vertical bump
  (s, { rng }) => {
    s.az = 13.6 + rng() * 2.4;
  },
  // Hard acceleration
  (s, { rng }) => {
    s.ax = 4.4 + rng() * 1.1;
    s.speed_kmh = 68 + rng() * 14;
  },
  // Brake + lateral (swerve)
  (s, { rng }) => {
    s.ax = -4.0 - rng() * 1.2;
    s.ay = 3.2 + rng() * 1.2;
    s.speed_kmh = 28 + rng() * 18;
  },
  // Second bump profile
  (s, { rng }) => {
    s.az = 12.9 + rng() * 2.2;
  },
  // Speeding with turn
  (s, { naturalLateral, rng }) => {
    s.speed_kmh = 88 + rng() * 16;
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

  const count = Math.max(1, Math.min(4, Math.floor(n / 52)));
  const indices = pickIncidentIndices(n, count, rng);
  const recipes = [...INCIDENT_LIBRARY];
  shuffleInPlace(recipes, rng);

  const map = new Map<number, IncidentApply>();
  for (let k = 0; k < indices.length; k++) {
    map.set(indices[k], recipes[k % recipes.length]);
  }
  return map;
}

function approxMeters(a: [number, number], b: [number, number]): number {
  const meanLat = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(meanLat);
  const dy = (b[0] - a[0]) * metersPerLat;
  const dx = (b[1] - a[1]) * metersPerLng;
  return Math.hypot(dx, dy);
}

function densifyPath(path: [number, number][], targetStepM = 14): [number, number][] {
  if (path.length < 2) return path;
  const out: [number, number][] = [path[0]];

  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const next = path[i];
    const steps = Math.max(1, Math.ceil(approxMeters(prev, next) / targetStepM));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      out.push([
        prev[0] + (next[0] - prev[0]) * t,
        prev[1] + (next[1] - prev[1]) * t,
      ]);
    }
  }

  return out;
}

/**
 * Motion stream from the route path: baseline noise + curvature-based lateral,
 * plus incidents placed at trip-unique indices with shuffled types and jittered magnitudes.
 */
function buildSamples(path: [number, number][], tripId: string): Sample[] {
  const densePath = densifyPath(path);
  const n = densePath.length;
  const incidents = buildIncidentPlan(n, tripId);
  const rng = mulberry32(hashTripSeed(tripId) ^ 0x9e3779b9);

  return densePath.map(([lat, lng], i) => {
    const progress = i / Math.max(n - 1, 1);

    let spd = 55;
    if (progress < 0.15) spd = 30 + (progress / 0.15) * 25;
    else if (progress > 0.85) spd = 55 - ((progress - 0.85) / 0.15) * 25;

    let naturalLateral = 0;
    if (i > 0 && i < n - 1) {
      const [la0, lo0] = densePath[i - 1];
      const [la1, lo1] = densePath[i];
      const [la2, lo2] = densePath[i + 1];
      const b0 = Math.atan2(lo1 - lo0, la1 - la0);
      const b1 = Math.atan2(lo2 - lo1, la2 - la1);
      const delta = b1 - b0;
      naturalLateral = Math.sin(delta) * 1.8;
    }

    const ax = 0.25 + (rng() - 0.5) * 0.15;
    const ay = naturalLateral + (rng() - 0.5) * 0.12;
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
  const [sideTab, setSideTab] = useState<"monitor" | "analytics">("monitor");
  const [streamRows, setStreamRows] = useState<StreamRow[]>([]);

  const tripIdRef = useRef<string | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const wsRef     = useRef<WebSocket | null>(null);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const samplesRef = useRef<ReturnType<typeof buildSamples>>([]);
  const idxRef    = useRef(0);
  const t0Ref     = useRef(0);
  const completingRef = useRef(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const resetToIdle = useCallback(() => {
    stopTimer();
    wsRef.current?.close();
    wsRef.current = null;
    tripIdRef.current = null;
    samplesRef.current = [];
    idxRef.current = 0;
    setPhase("idle");
    setGeojson(emptyFc);
    setEvents([]);
    setLive(null);
    setResult(null);
    setErr(null);
    setWsReady(false);
    setRoutingNote(null);
    setStartPlace(null);
    setEndPlace(null);
    setUseDemoRoute(false);
    completingRef.current = false;
    setStreamRows([]);
  }, [stopTimer]);

  // ── Step 1: Book trip ──────────────────────────────────────────────────────
  const startTrip = useCallback(async () => {
    completingRef.current = false;
    setErr(null); setResult(null); setEvents([]); setLive(null);
    setGeojson(emptyFc); setPhase("idle"); setWsReady(false);
    setRoutingNote(null);
    setStreamRows([]);

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
            const lim =
              msg.baselines && typeof msg.baselines.speed_limit_kmh === "number"
                ? msg.baselines.speed_limit_kmh
                : null;
            setLive({
              comfort: msg.comfort,
              current_segment: msg.current_segment,
              segment_count: msg.segment_count,
              position: msg.position,
              speed_limit_kmh: lim,
              metrics: msg.metrics,
            });
            if (msg.segment_geojson) setGeojson(msg.segment_geojson);
            if (msg.new_events?.length) {
              setEvents((prev) => [...prev, ...msg.new_events]);
            }
            const m = msg.metrics;
            const p = msg.position;
            if (m && p) {
              setStreamRows((prev) => {
                const row: StreamRow = {
                  t_ms: typeof msg.t_ms === "number" ? msg.t_ms : 0,
                  lat: p.lat,
                  lng: p.lng,
                  comfort: msg.comfort,
                  lateral_mps2: m.lateral_mps2,
                  brake_mps2: m.brake_mps2,
                  jerk_mps3: m.jerk_mps3,
                  speed_kmh: m.speed_kmh,
                };
                const next = [...prev, row];
                return next.length > 4000 ? next.slice(-3000) : next;
              });
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

  // ── Step 3: Complete trip ──────────────────────────────────────────────────
  const endTrip = useCallback(async () => {
    if (completingRef.current) return;
    completingRef.current = true;
    stopTimer();
    wsRef.current?.close();
    const id = tripIdRef.current;
    if (!id) {
      completingRef.current = false;
      return;
    }
    try {
      const res = await fetch(`${getApiUrl()}/trips/${id}/complete`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
      const r = await res.json() as FinalResult;
      setResult(r);
      if (r.events?.length) setEvents(r.events);
      setPhase("done");
      completingRef.current = false;
    } catch (e) {
      completingRef.current = false;
      setErr(`Complete failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [stopTimer]);

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
      if (idxRef.current >= samples.length) {
        stopTimer();
        window.setTimeout(() => {
          void endTrip();
        }, 500);
      }
    }, 80);
  }, [stopTimer, endTrip]);

  // Auto-run simulator once WS is open
  useEffect(() => {
    if (wsReady && phase === "running" && idxRef.current === 0 && !timerRef.current) {
      runSimulator();
    }
  }, [wsReady, phase, runSimulator]);

  const pickPins: PlanPin[] | null =
    phase === "idle" && startPlace && endPlace && !useDemoRoute
      ? [
          { role: "start", lat: startPlace.lat, lng: startPlace.lng },
          { role: "end", lat: endPlace.lat, lng: endPlace.lng },
        ]
      : null;

  const redStreamRows = useMemo(
    () => streamRows.filter((r) => r.comfort === "red"),
    [streamRows],
  );

  useEffect(() => {
    if (sideTab !== "analytics" || !redStreamRows.length) return;
    streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [redStreamRows.length, sideTab]);

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
        </div>

        <div className="pointer-events-auto absolute bottom-4 left-4 right-4 flex min-h-0 max-h-[72vh] flex-col gap-5 overflow-hidden rounded-lg border border-zinc-200 bg-white/95 p-5 shadow-2xl backdrop-blur md:bottom-4 md:left-auto md:top-4 md:w-80 md:max-h-none">
          <div className="grid shrink-0 grid-cols-2 rounded-lg border border-zinc-200 bg-zinc-100 p-1 text-sm font-medium">
            <button
              type="button"
              onClick={() => setSideTab("monitor")}
              className={
                sideTab === "monitor"
                  ? "rounded-md bg-white px-3 py-2 text-zinc-900 shadow-sm"
                  : "rounded-md px-3 py-2 text-zinc-600 transition-colors hover:bg-white/70 hover:text-zinc-900"
              }
            >
              Monitor
            </button>
            <button
              type="button"
              onClick={() => setSideTab("analytics")}
              className={
                sideTab === "analytics"
                  ? "rounded-md bg-white px-3 py-2 text-zinc-900 shadow-sm"
                  : "rounded-md px-3 py-2 text-zinc-600 transition-colors hover:bg-white/70 hover:text-zinc-900"
              }
            >
              Analytics
            </button>
          </div>

          {sideTab === "monitor" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <>
          {/* ── Idle: pre-trip ────────────────────────────────────────── */}
          {phase === "idle" && (
            <div className="flex flex-col gap-5">
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-5 text-sm leading-relaxed text-zinc-600">
                <p className="mb-2 text-zinc-800 font-medium">How it works</p>
                <p>Search any start and end in Singapore, then run a simulation along the driving route. We highlight <span className="text-zinc-800 font-medium">speed vs the posted limit</span>, <span className="text-zinc-800 font-medium">uneven or hard acceleration</span>, braking, lateral motion, and bumps — as motion signals on each segment, not as feedback to anyone.</p>
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-white p-3 text-xs text-zinc-700">
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
                <div className="flex flex-col gap-4">
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
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Lateral G" value={`${(live?.metrics.lateral_mps2 ?? 0).toFixed(2)}`} unit="m/s²" />
                <Metric label="Braking G" value={`${(live?.metrics.brake_mps2 ?? 0).toFixed(2)}`} unit="m/s²" />
                <Metric label="Jerk" value={`${(live?.metrics.jerk_mps3 ?? 0).toFixed(1)}`} unit="m/s³" />
                <Metric
                  label="Speed (segment cap)"
                  value={
                    live?.speed_limit_kmh != null
                      ? `${(live?.metrics.speed_kmh ?? 0).toFixed(0)} / ${live.speed_limit_kmh.toFixed(0)}`
                      : `${(live?.metrics.speed_kmh ?? 0).toFixed(0)}`
                  }
                  unit="km/h"
                />
              </div>

              {events.length > 0 && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-4">
                  <p className="mb-3 text-xs font-medium text-zinc-600">Detected Events</p>
                  <ul className="flex flex-col gap-2">
                    {events.slice(-5).reverse().map((ev) => (
                      <li key={ev.id} className="flex items-center gap-2 text-xs">
                        <span>{ev.icon}</span>
                        <span className="text-zinc-700 flex-1">{ev.label}</span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: (CONTEXT_COLORS[ev.attributed_to] ?? "#71717a") + "22",
                            color: CONTEXT_COLORS[ev.attributed_to] ?? "#71717a",
                          }}
                        >
                          {CONTEXT_LABELS[ev.attributed_to] ?? ev.attributed_to}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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

              {/* Event breakdown (by type) */}
              {result.stats.total_events > 0 && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-4">
                  <p className="mb-3 text-xs font-medium text-zinc-600">What we detected</p>
                  <div className="flex flex-col gap-2.5">
                    {[
                      ...EVENT_BREAKDOWN_ORDER.filter((k) => (result.event_counts[k] ?? 0) > 0),
                      ...Object.keys(result.event_counts).filter((k) => !EVENT_BREAKDOWN_ORDER.includes(k)),
                    ].map((key) => {
                        const n = result.event_counts[key] ?? 0;
                        const maxN = Math.max(...Object.values(result.event_counts), 1);
                        const pct = Math.round((n / maxN) * 100);
                        return (
                          <div key={key} className="flex items-center gap-2">
                            <span className="text-xs w-[8.5rem] shrink-0 text-zinc-600 leading-tight">
                              {EVENT_TYPE_LABELS[key] ?? key.replace(/_/g, " ")}
                            </span>
                            <div className="flex-1 h-2 rounded-full bg-zinc-200 overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all bg-zinc-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-zinc-600 w-6 text-right tabular-nums">{n}</span>
                          </div>
                        );
                      })}
                  </div>
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
                            background: (CONTEXT_COLORS[ev.attributed_to] ?? "#71717a") + "22",
                            color: CONTEXT_COLORS[ev.attributed_to] ?? "#71717a",
                          }}
                        >
                          {CONTEXT_LABELS[ev.attributed_to] ?? ev.attributed_to}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                type="button"
                onClick={resetToIdle}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white py-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
              >
                New Trip
              </button>
            </div>
          )}

            </>
            </div>
          )}

          {sideTab === "analytics" && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="shrink-0">
                <p className="text-sm font-medium text-zinc-800">Rough samples (red)</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {phase === "idle" &&
                    "Only instant red-band samples are listed — same WebSocket stream as the map, filtered to rough moments."}
                  {phase === "running" &&
                    `${redStreamRows.length} rough · ${streamRows.length} total samples`}
                  {phase === "done" &&
                    `${redStreamRows.length} rough · ${streamRows.length} total samples in the last trip`}
                </p>
              </div>

              {streamRows.length === 0 ? (
                <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/95 p-4 text-xs text-zinc-600">
                  {phase === "idle"
                    ? "No trip yet. Book a trip on Monitor, then open this tab during the run to see rough samples only."
                    : "Waiting for the first position update…"}
                </div>
              ) : redStreamRows.length === 0 ? (
                <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/95 p-4 text-xs text-zinc-600">
                  No red-band samples in this trip yet — motion stayed in the green/yellow comfort band at every logged instant.
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50/30">
                  <ul className="flex flex-col gap-1.5 p-2">
                    {redStreamRows.map((r, i) => (
                      <li
                        key={`${r.t_ms}-red-${i}`}
                        className={`rounded-r-md border border-zinc-200/80 py-1.5 pl-2.5 pr-2 text-left ${STREAM_TONE.red.line}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-zinc-500">
                            t={r.t_ms.toFixed(0)}ms · rough #{i + 1}
                          </span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${STREAM_TONE.red.chip}`}>
                            red
                          </span>
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-zinc-800">
                          {r.lat.toFixed(5)}°, {r.lng.toFixed(5)}°
                        </p>
                        <p className="text-[10px] text-zinc-600">
                          lateral {r.lateral_mps2.toFixed(2)} · brake {r.brake_mps2.toFixed(2)} · jerk {r.jerk_mps3.toFixed(1)} · {r.speed_kmh.toFixed(0)} km/h
                        </p>
                      </li>
                    ))}
                  </ul>
                  <div ref={streamEndRef} className="h-0 w-full shrink-0" aria-hidden />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {err && (
            <div className="shrink-0 rounded-lg border border-red-200 bg-red-50/95 p-3 text-xs text-red-700">
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
