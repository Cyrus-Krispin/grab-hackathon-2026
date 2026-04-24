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

const SOURCE = "route-comfort";
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


type Props = {
  geojson: SegmentGeo;
  events: RideEvent[];
};

export function ComfortMap({ geojson, events }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef       = useRef<Map | null>(null);
  const geoRef       = useRef(geojson);
  const markersRef   = useRef<Record<string, maplibregl.Marker>>({});
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
        center: [103.848, 1.328],
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
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Update route source when geojson changes
  useEffect(() => {
    if (!ready) return;
    const src = mapRef.current?.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(geojson);
  }, [geojson, ready]);

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
      el.title = `${ev.label} — ${ev.attributed_to}`;
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([ev.lng, ev.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(
            `<div style="background:#18181b;color:#fafafa;padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.5">
              <strong>${ev.icon} ${ev.label}</strong><br/>
              Attributed to: <em>${ev.attributed_to}</em><br/>
              Magnitude: ${ev.magnitude.toFixed(2)}
            </div>`
          )
        )
        .addTo(map);
      existing[ev.id] = marker;
    }
  }, [events, ready]);

  return (
    <div ref={containerRef} className="w-full h-full" />
  );
}
