"use client";

import maplibregl, { Map, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

/**
 * Map style: SKILL.md §2.8, §5 — `GET {base}/api/style.json` with
 * `Authorization: Bearer <key>`, pass the JSON to MapLibre (not `?key=` on the URL).
 * `transformRequest` still adds Bearer to tile/vector fetches to maps.grab.com.
 */

export type SegmentGeo = GeoJSON.FeatureCollection<GeoJSON.LineString>;

const SOURCE_ID = "route-comfort";
const LAYER_ID = "route-comfort-line";

const CARTO_POSITRON =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const COLOR_EXPR: maplibregl.DataDrivenPropertyValueSpecification<string> = [
  "match",
  ["get", "comfort"],
  "green",
  "#22c55e",
  "yellow",
  "#ca8a04",
  "red",
  "#ef4444",
  "#22c55e",
];

type Props = {
  geojson: SegmentGeo;
  className?: string;
};

function defaultGrabBase(): string {
  return (
    process.env.NEXT_PUBLIC_GRABMAPS_BASE_URL?.replace(/\/$/, "") ||
    "https://maps.grab.com"
  );
}

function fitBounds(
  map: Map,
  fc: GeoJSON.FeatureCollection<GeoJSON.LineString>
): void {
  if (!fc?.features?.length) return;
  const coords: [number, number][] = [];
  for (const f of fc.features) {
    for (const c of f.geometry?.coordinates || []) {
      coords.push(c as [number, number]);
    }
  }
  if (!coords.length) return;
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) b.extend(c);
  map.fitBounds(b, { padding: 64, maxZoom: 16, duration: 400 });
}

function needsGrabAuth(url: string, grabBase: string): boolean {
  if (url.startsWith(grabBase)) return true;
  if (grabBase.includes("maps.grab.com") && url.includes("maps.grab.com")) {
    return true;
  }
  return false;
}

export function ComfortMap({ geojson, className }: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const geoRef = useRef(geojson);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    geoRef.current = geojson;
  }, [geojson]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const grabBase = defaultGrabBase();
    const key = process.env.NEXT_PUBLIC_GRABMAPS_API_KEY;

    let map: Map | null = null;
    let alive = true;

    (async () => {
      let style: string | StyleSpecification;
      if (key) {
        const styleRes = await fetch(`${grabBase}/api/style.json`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!styleRes.ok) {
          if (!alive) return;
          console.warn("Grab style.json failed, using fallback basemap", styleRes.status);
          style = CARTO_POSITRON;
        } else {
          style = (await styleRes.json()) as StyleSpecification;
        }
      } else {
        style = CARTO_POSITRON;
      }
      if (!alive || !el) return;

      map = new maplibregl.Map({
        container: el,
        style,
        center: [103.833, 1.304],
        zoom: 11.5,
        transformRequest: (url, _resourceType) => {
          if (key && needsGrabAuth(url, grabBase)) {
            return { url, headers: { Authorization: `Bearer ${key}` } };
          }
          return { url };
        },
      });
      map.addControl(new maplibregl.NavigationControl(), "top-right");
      mapRef.current = map;

      map.on("load", () => {
        if (!map) return;
        const g = geoRef.current;
        map.addSource(SOURCE_ID, { type: "geojson", data: g });
        map.addLayer({
          id: LAYER_ID,
          type: "line",
          source: SOURCE_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-width": 6,
            "line-color": COLOR_EXPR,
          },
        });
        fitBounds(map, g);
        setMapReady(true);
      });
    })();

    return () => {
      alive = false;
      setMapReady(false);
      if (map) {
        map.remove();
        map = null;
      }
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(geojson);
      fitBounds(map, geojson);
    }
  }, [geojson, mapReady]);

  return (
    <div
      ref={container}
      className={
        className ||
        "h-[420px] w-full rounded-lg border border-zinc-200 dark:border-zinc-800 shadow-sm"
      }
    />
  );
}
