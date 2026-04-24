"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ComfortMap, type SegmentGeo } from "./ComfortMap";
import { getApiUrl, tripWsUrl } from "@/lib/config";

type StateMsg = {
  type: string;
  in_range?: boolean;
  current_segment?: number;
  comfort?: string;
  metrics?: { lateral_mps2?: number; brake_mps2?: number; jerk_mps3?: number };
  baselines?: Record<string, number>;
};

const emptyFc: SegmentGeo = { type: "FeatureCollection", features: [] };

export function RideConsole() {
  const [geojson, setGeojson] = useState<SegmentGeo>(emptyFc);
  const [log, setLog] = useState<StateMsg[]>([]);
  const [summary, setSummary] = useState<{
    score: number;
    summary: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [tripId, setTripId] = useState<string | null>(null);
  const pathRef = useRef<[number, number][]>([]);
  const idxRef = useRef(0);
  const t0Ref = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const injectRef = useRef(0);

  const startTrip = useCallback(async () => {
    setErr(null);
    setSummary(null);
    setLog([]);
    const base = getApiUrl();
    const r = await fetch(`${base}/trips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useFixture: true }),
    });
    if (!r.ok) {
      setErr(`Start failed: ${r.status} ${await r.text()}`);
      return;
    }
    const d = (await r.json()) as {
      trip_id: string;
      geojson: SegmentGeo;
      path_lat_lng: [number, number][];
    };
    setTripId(d.trip_id);
    setGeojson(d.geojson);
    pathRef.current = d.path_lat_lng || [];
    idxRef.current = 0;
    t0Ref.current = performance.now();
  }, []);

  const connectWs = useCallback((): WebSocket | null => {
    if (!tripId) return null;
    const w = new WebSocket(tripWsUrl(tripId));
    w.onopen = () => setWsOpen(true);
    w.onclose = () => setWsOpen(false);
    w.onmessage = (ev) => {
      try {
        const j = JSON.parse(ev.data) as StateMsg & {
          segment_geojson?: SegmentGeo;
        };
        if (j.type === "state") {
          setLog((prev) => {
            const n = [j, ...prev].slice(0, 6);
            return n;
          });
        }
        if (
          (j as { segment_geojson?: SegmentGeo }).segment_geojson
        ) {
          setGeojson(
            (j as { segment_geojson: SegmentGeo }).segment_geojson
          );
        }
      } catch {
        // ignore
      }
    };
    w.onerror = () => setErr("WebSocket error");
    wsRef.current = w;
    return w;
  }, [tripId]);

  useEffect(() => {
    if (!tripId) return;
    const w = connectWs();
    if (!w) return;
    return () => {
      setWsOpen(false);
      w.close();
      wsRef.current = null;
    };
  }, [tripId, connectWs]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRunning(false);
  }, []);

  const endTrip = useCallback(async () => {
    stopTimer();
    wsRef.current?.close();
    if (!tripId) return;
    const r = await fetch(`${getApiUrl()}/trips/${tripId}/complete`, {
      method: "POST",
    });
    if (r.ok) {
      const s = (await r.json()) as { score: number; summary: string };
      setSummary({ score: s.score, summary: s.summary });
    }
  }, [stopTimer, tripId]);

  const startSimulation = useCallback(() => {
    if (!pathRef.current.length || !wsRef.current) {
      setErr("Start a trip first to load the path.");
      return;
    }
    if (wsRef.current.readyState !== WebSocket.OPEN) {
      setErr("WebSocket is not open yet. Wait a second after starting.");
      return;
    }
    setErr(null);
    setRunning(true);
    t0Ref.current = performance.now();
    injectRef.current = 0;
    idxRef.current = 0;
    timerRef.current = setInterval(() => {
      const path = pathRef.current;
      if (!path.length) return;
      const i = idxRef.current % path.length;
      const [lat, lng] = path[i];
      idxRef.current = i + 1;
      let ax = 0.3 + (Math.random() - 0.5) * 0.2;
      let ay = 0.2 + (Math.random() - 0.5) * 0.2;
      if (i % 40 === 15 && injectRef.current < 3) {
        ax = -6.0;
        injectRef.current += 1;
      }
      if (i % 50 === 30 && injectRef.current < 5) {
        ay = 4.5;
        injectRef.current += 1;
      }
      const tMs = performance.now() - t0Ref.current;
      const msg = {
        type: "sample" as const,
        t_ms: tMs,
        lat,
        lng,
        ax,
        ay,
        az: 9.2 + (Math.random() - 0.5) * 0.1,
      };
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    }, 90);
  }, [stopTimer]);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6 p-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Ride comfort (simulated) — Singapore route
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Map: fetch Grab <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">/api/style.json</code> with Bearer
          (see <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">SKILL.md</code>); base defaults to
          <code className="mx-0.5 rounded bg-zinc-100 px-1 dark:bg-zinc-800">https://maps.grab.com</code> when unset.
          Without <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">NEXT_PUBLIC_GRABMAPS_API_KEY</code> a
          neutral basemap is used. FastAPI calls directions with
          <code className="mx-0.5 rounded bg-zinc-100 px-1 dark:bg-zinc-800">coordinates=lng,lat</code> per the same
          spec.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
          onClick={startTrip}
        >
          1) Start trip (fixture)
        </button>
        <button
          type="button"
          className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          onClick={startSimulation}
          disabled={!tripId || !wsOpen}
        >
          2) Run simulator
        </button>
        <button
          type="button"
          className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          onClick={endTrip}
          disabled={!tripId}
        >
          3) End &amp; score
        </button>
      </div>

      {err && (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          {err}
        </p>
      )}

      {summary && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
          <p className="text-lg font-medium">Score: {summary.score.toFixed(1)} / 100</p>
          <p className="text-sm">{summary.summary}</p>
        </div>
      )}

      <ComfortMap geojson={geojson} />

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <h2 className="mb-2 font-medium text-zinc-800 dark:text-zinc-200">Status</h2>
          <p>tripId: {tripId ?? "—"}</p>
          <p>WebSocket: {wsOpen ? (running ? "open · simulating" : "open") : "connecting/closed"}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <h2 className="mb-2 font-medium text-zinc-800 dark:text-zinc-200">Latest samples</h2>
          {log.length === 0 && <p className="text-zinc-500">No samples yet.</p>}
          <ul className="space-y-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">
            {log.map((s, i) => (
              <li key={i}>
                seg {s.current_segment} · {s.comfort} · in_range:{" "}
                {s.in_range === false ? "no" : "yes"} · lat {s.metrics?.lateral_mps2?.toFixed(2) ?? 0} ·
                j {(s.metrics?.jerk_mps3 ?? 0).toFixed(1)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
