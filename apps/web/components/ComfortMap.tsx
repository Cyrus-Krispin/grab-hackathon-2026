"use client";

/**
 * ComfortMap
 *
 * Map style: SKILL.md §2.8 — fetch GET {base}/api/style.json with
 * Authorization: Bearer <key>, parse JSON, pass object to MapLibre.
 * transformRequest adds Bearer to all subsequent tile requests to maps.grab.com.
 * Falls back to Carto Positron if no key is configured.
 */

import maplibregl, { Map, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { getApiUrl } from "@/lib/config";

export type SegmentGeo = GeoJSON.FeatureCollection<GeoJSON.LineString>;

export type RideEvent = {
  id: string;
  type: string;
  lat: number;
  lng: number;
  attributed_to: string;
  label: string;
  icon: string;
  magnitude: number;
};

export type CurrentPosition = {
  lat: number;
  lng: number;
  heading_deg: number;
};

export type PlanPin = { lat: number; lng: number; role: "start" | "end" };

const CONTEXT_LABELS: Record<string, string> = {
  vehicle: "Vehicle motion",
  traffic: "Traffic flow",
  road: "Road surface",
  route: "Route shape",
};

const SOURCE = "route-comfort";
const PLAN_START_ID = "_plan-start";
const PLAN_END_ID = "_plan-end";
const ROUTE_START_ID = "_route-start";
const ROUTE_END_ID = "_route-end";
const LAYER  = "route-comfort-line";
const CARTO  = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// Data-driven color from segment `comfort` property
const COLOR_EXPR: maplibregl.DataDrivenPropertyValueSpecification<string> = [
  "match", ["get", "comfort"],
  "green",  "#00b14f",
  "yellow", "#f59e0b",
  "red",    "#ef4444",
  "#00b14f",
];

function fitRoute(map: Map, fc: SegmentGeo) {
  const coords: [number, number][] = [];
  for (const f of fc.features) {
    for (const c of (f.geometry?.coordinates ?? [])) coords.push(c as [number, number]);
  }
  if (!coords.length) return;
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) b.extend(c);
  map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
}

function routeEndpoints(fc: SegmentGeo): PlanPin[] {
  const coords: [number, number][] = [];
  for (const f of fc.features) {
    for (const c of (f.geometry?.coordinates ?? [])) coords.push(c as [number, number]);
  }
  if (coords.length < 2) return [];
  const first = coords[0];
  const last = coords[coords.length - 1];
  return [
    { role: "start", lng: first[0], lat: first[1] },
    { role: "end", lng: last[0], lat: last[1] },
  ];
}


type Props = {
  geojson: SegmentGeo;
  events: RideEvent[];
  currentPosition?: CurrentPosition | null;
  pickPins?: PlanPin[] | null;
};

export function ComfortMap({ geojson, events, currentPosition, pickPins }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef       = useRef<Map | null>(null);
  const geoRef       = useRef(geojson);
  const markersRef   = useRef<Record<string, maplibregl.Marker>>({});
  const carMarkerRef = useRef<maplibregl.Marker | null>(null);
  const carPositionRef = useRef<CurrentPosition | null>(null);
  const carFrameRef = useRef<number | null>(null);
  const fittedRouteRef = useRef(false);
  const [ready, setReady] = useState(false);

  // Keep geoRef in sync
  useEffect(() => { geoRef.current = geojson; }, [geojson]);

  // Initialise map once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let alive = true;
    let map: Map | null = null;

    (async () => {
      // Style fetched from our backend — keeps the GrabMaps API key server-side
      let style: string | StyleSpecification = CARTO;
      try {
        const res = await fetch(`${getApiUrl()}/map-style`);
        if (res.ok) style = (await res.json()) as StyleSpecification;
        else console.warn("Backend /map-style →", res.status, "— using fallback");
      } catch (err) {
        console.warn("/map-style fetch failed:", err);
      }
      if (!alive || !el) return;

      map = new maplibregl.Map({
        container: el,
        style,
        center: [103.888, 1.329],
        zoom: 12,
      });

      map.addControl(new maplibregl.NavigationControl(), "top-right");
      mapRef.current = map;

      map.on("load", () => {
        if (!map) return;
        const g = geoRef.current;
        map.addSource(SOURCE, { type: "geojson", data: g });
        map.addLayer({
          id: LAYER,
          type: "line",
          source: SOURCE,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-width": ["interpolate", ["linear"], ["zoom"], 11, 4, 15, 8],
            "line-color": COLOR_EXPR,
          },
        });
        fitRoute(map, g);
        setReady(true);
      });
    })();

    return () => {
      alive = false;
      setReady(false);
      Object.values(markersRef.current).forEach((m) => m.remove());
      markersRef.current = {};
      if (carFrameRef.current) cancelAnimationFrame(carFrameRef.current);
      carFrameRef.current = null;
      carPositionRef.current = null;
      carMarkerRef.current?.remove();
      carMarkerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Update route source when geojson changes
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const src = map?.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(geojson);
    if (!geojson.features.length) {
      fittedRouteRef.current = false;
      if (carFrameRef.current) cancelAnimationFrame(carFrameRef.current);
      carFrameRef.current = null;
      carPositionRef.current = null;
      carMarkerRef.current?.remove();
      carMarkerRef.current = null;
      for (const k of [ROUTE_START_ID, ROUTE_END_ID]) {
        markersRef.current[k]?.remove();
        delete markersRef.current[k];
      }
      return;
    }
    if (map && !fittedRouteRef.current) {
      fitRoute(map, geojson);
      fittedRouteRef.current = true;
    }
  }, [geojson, ready]);

  // Fixed route start / end markers after a route is loaded
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const existing = markersRef.current;
    for (const k of [ROUTE_START_ID, ROUTE_END_ID]) {
      existing[k]?.remove();
      delete existing[k];
    }
    for (const pin of routeEndpoints(geojson)) {
      const id = pin.role === "start" ? ROUTE_START_ID : ROUTE_END_ID;
      const el = document.createElement("div");
      el.className = `plan-pin plan-pin-${pin.role}`;
      el.textContent = pin.role === "start" ? "A" : "B";
      el.title = pin.role === "start" ? "Route start" : "Route end";
      existing[id] = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([pin.lng, pin.lat])
        .addTo(map);
    }
  }, [geojson, ready]);

  // Move the live car pointer as samples arrive
  useEffect(() => {
    if (!ready || !mapRef.current || !currentPosition) return;
    if (!Number.isFinite(currentPosition.lng) || !Number.isFinite(currentPosition.lat)) return;
    const map = mapRef.current;
    const lngLat: [number, number] = [currentPosition.lng, currentPosition.lat];
    if (!carMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "car-marker";
      el.title = "Current ride position";
      carMarkerRef.current = new maplibregl.Marker({
        element: el,
        anchor: "center",
        rotationAlignment: "map",
      })
        .setLngLat(lngLat)
        .setRotation(currentPosition.heading_deg)
        .addTo(map);
      carPositionRef.current = currentPosition;
      map.easeTo({
        center: lngLat,
        duration: 350,
        essential: true,
      });
      return;
    }

    if (carFrameRef.current) cancelAnimationFrame(carFrameRef.current);
    const from = carPositionRef.current ?? currentPosition;
    const to = currentPosition;
    const startedAt = performance.now();
    const durationMs = 300;
    const headingDelta = ((((to.heading_deg - from.heading_deg) % 360) + 540) % 360) - 180;

    const animate = (now: number) => {
      const raw = Math.min(1, (now - startedAt) / durationMs);
      const progress = 1 - Math.pow(1 - raw, 3);
      const next = {
        lat: from.lat + (to.lat - from.lat) * progress,
        lng: from.lng + (to.lng - from.lng) * progress,
        heading_deg: (from.heading_deg + headingDelta * progress + 360) % 360,
      };
      carPositionRef.current = next;
      carMarkerRef.current
        ?.setLngLat([next.lng, next.lat])
        .setRotation(next.heading_deg);

      if (raw < 1) {
        carFrameRef.current = requestAnimationFrame(animate);
      } else {
        carFrameRef.current = null;
        carPositionRef.current = to;
      }
    };

    carFrameRef.current = requestAnimationFrame(animate);
    map.easeTo({
      center: lngLat,
      duration: 500,
      essential: true,
    });
  }, [currentPosition, ready]);

  // Sync event markers
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const existing = markersRef.current;

    // Add new markers
    for (const ev of events) {
      if (existing[ev.id]) continue;
      const el = document.createElement("div");
      el.className = "event-marker";
      el.textContent = ev.icon;
      const ctx = CONTEXT_LABELS[ev.attributed_to] ?? ev.attributed_to;
      el.title = `${ev.label} — ${ctx}`;
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([ev.lng, ev.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(
            `<div style="background:#18181b;color:#fafafa;padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.5">
              <strong>${ev.icon} ${ev.label}</strong><br/>
              Context: <em>${ctx}</em><br/>
              Magnitude: ${ev.magnitude.toFixed(2)}
            </div>`
          )
        )
        .addTo(map);
      existing[ev.id] = marker;
    }
  }, [events, ready]);

  // Start / end picks (idle planning)
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const existing = markersRef.current;
    for (const k of [PLAN_START_ID, PLAN_END_ID]) {
      existing[k]?.remove();
      delete existing[k];
    }
    if (!pickPins?.length) return;
    for (const pin of pickPins) {
      if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) continue;
      const id = pin.role === "start" ? PLAN_START_ID : PLAN_END_ID;
      const el = document.createElement("div");
      el.className = `plan-pin plan-pin-${pin.role === "start" ? "start" : "end"}`;
      el.textContent = pin.role === "start" ? "A" : "B";
      el.title = pin.role === "start" ? "Start" : "End";
      existing[id] = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([pin.lng, pin.lat])
        .addTo(map);
    }
  }, [pickPins, ready]);

  return (
    <div ref={containerRef} className="w-full h-full" />
  );
}
