"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ComfortMap, type RideEvent, type SegmentGeo } from "./ComfortMap";
import { getApiUrl } from "@/lib/config";

type RoadSegment = {
  segment_id: number;
  status: "clear" | "watch" | "maintenance";
  comfort: "green" | "yellow" | "red";
  road_events: number;
  driver_events: number;
  traffic_events: number;
  route_events: number;
  reports: number;
  rides_observed: number;
  confidence: number;
  length_m: number;
  lat: number;
  lng: number;
};

type OpsStatus = {
  source: "live" | "demo";
  ride_count: number;
  segments: RoadSegment[];
  geojson: SegmentGeo;
  hotspots: RideEvent[];
  summary: {
    segments_tracked: number;
    maintenance: number;
    watch: number;
    clear: number;
    road_events: number;
    driver_events: number;
  };
};

const emptyFc: SegmentGeo = { type: "FeatureCollection", features: [] };

const STATUS_STYLES: Record<RoadSegment["status"], { label: string; pill: string; dot: string }> = {
  clear: {
    label: "Clear",
    pill: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  watch: {
    label: "Watch",
    pill: "bg-amber-50 text-amber-700 border-amber-200",
    dot: "bg-amber-500",
  },
  maintenance: {
    label: "Priority",
    pill: "bg-red-50 text-red-700 border-red-200",
    dot: "bg-red-500",
  },
};

export function OpsAnalytics() {
  const [data, setData] = useState<OpsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${getApiUrl()}/ops/road-status`, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const next = await res.json() as OpsStatus;
        if (alive) setData(next);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  const prioritySegments = useMemo(
    () => (data?.segments ?? []).filter((segment) => segment.status !== "clear").slice(0, 8),
    [data],
  );

  const roadShare = data
    ? Math.round(data.summary.road_events / Math.max(1, data.summary.road_events + data.summary.driver_events) * 100)
    : 0;

  return (
    <main className="relative h-full w-full overflow-hidden bg-zinc-100 text-zinc-900">
      <ComfortMap geojson={data?.geojson ?? emptyFc} events={data?.hotspots ?? []} />

      <div className="pointer-events-none absolute inset-0 z-10">
        <header className="absolute left-4 right-4 top-4 flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white/95 p-4 shadow-xl backdrop-blur md:left-4 md:right-auto md:w-[520px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold" style={{ color: "#00b14f" }}>Grab</span>
                <span className="text-sm font-medium text-zinc-800">Ops Road Intelligence</span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Road health from driver ride comfort signals
              </p>
            </div>
            <Link
              href="/"
              className="pointer-events-auto rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              Ride demo
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Rides" value={data?.ride_count ?? "-"} />
            <Kpi label="Priority" value={data?.summary.maintenance ?? "-"} tone="red" />
            <Kpi label="Watch" value={data?.summary.watch ?? "-"} tone="amber" />
            <Kpi label="Road share" value={data ? `${roadShare}%` : "-"} />
          </div>
        </header>

        <section className="pointer-events-auto absolute bottom-4 left-4 right-4 max-h-[52vh] overflow-y-auto rounded-lg border border-zinc-200 bg-white/95 p-4 shadow-2xl backdrop-blur md:bottom-4 md:left-auto md:top-4 md:w-[430px] md:max-h-none">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold text-zinc-900">Road Status Queue</h1>
              <p className="mt-1 text-xs text-zinc-500">
                {data?.source === "live" ? "Live in-memory trip events" : "Demo ride signal baseline"}
              </p>
            </div>
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600">
              {data?.summary.segments_tracked ?? 0} segments
            </span>
          </div>

          {err && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {err}
            </div>
          )}

          <div className="mb-4 grid grid-cols-3 gap-3 text-center text-xs">
            <StatusCount label="Clear" value={data?.summary.clear ?? 0} status="clear" />
            <StatusCount label="Watch" value={data?.summary.watch ?? 0} status="watch" />
            <StatusCount label="Priority" value={data?.summary.maintenance ?? 0} status="maintenance" />
          </div>

          <div className="flex flex-col gap-3">
            {prioritySegments.length === 0 && !err && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
                No road segments need ops attention yet.
              </div>
            )}

            {prioritySegments.map((segment) => (
              <article key={segment.segment_id} className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${STATUS_STYLES[segment.status].dot}`} />
                      <h2 className="text-sm font-semibold text-zinc-900">
                        Segment {segment.segment_id + 1}
                      </h2>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      {segment.rides_observed} driver rides observed · {segment.length_m.toFixed(0)} m
                    </p>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[segment.status].pill}`}>
                    {STATUS_STYLES[segment.status].label}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
                  <Signal label="Road" value={segment.road_events} />
                  <Signal label="Traffic" value={segment.traffic_events} />
                  <Signal label="Driver" value={segment.driver_events} />
                  <Signal label="Conf." value={`${segment.confidence}%`} />
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: "red" | "amber" }) {
  const color = tone === "red" ? "#ef4444" : tone === "amber" ? "#f59e0b" : "#00b14f";
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-3">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-bold leading-none" style={{ color }}>{value}</p>
    </div>
  );
}

function StatusCount({ label, value, status }: { label: string; value: number; status: RoadSegment["status"] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 p-3">
      <div className="mx-auto mb-2 flex items-center justify-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${STATUS_STYLES[status].dot}`} />
        <span className="text-xs text-zinc-500">{label}</span>
      </div>
      <p className="text-lg font-bold text-zinc-900">{value}</p>
    </div>
  );
}

function Signal({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-2">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-zinc-900">{value}</p>
    </div>
  );
}
