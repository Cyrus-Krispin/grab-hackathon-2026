const rawApi = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "";
const rawWs = process.env.NEXT_PUBLIC_WS_URL?.replace(/\/$/, "") || "";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalhostUrl(url: string): boolean {
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return true;
  }
}

function isLocalHostName(h: string): boolean {
  return LOCAL.has(h);
}

/** When true, HTTP clients use same-origin /api/ride (Vercel proxy) and WSS is resolved from the server. */
export function shouldUseApiProxy(): boolean {
  if (typeof window === "undefined") return false;
  if (isLocalHostName(window.location.hostname)) return false;
  if (rawApi && !isLocalhostUrl(rawApi)) return false;
  return true;
}

/**
 * If the page is served over https but the API URL is a non-local http:// URL, upgrade to https://
 * to avoid mixed-content blocks (e.g. Safari: "Load failed").
 */
function httpsIfSecurePage(url: string): string {
  if (typeof window === "undefined") return url;
  if (window.location.protocol !== "https:") return url;
  if (isLocalhostUrl(url)) return url;
  if (url.startsWith("http://")) {
    return `https://${url.slice(7)}`;
  }
  return url;
}

function httpToWebSocketBase(apiBase: string): string {
  const u = httpsIfSecurePage(apiBase);
  if (u.startsWith("https://")) return `wss://${u.slice(8)}`;
  if (u.startsWith("http://")) {
    if (typeof window !== "undefined" && window.location.protocol === "https:" && !isLocalhostUrl(u)) {
      return `wss://${u.slice(7)}`;
    }
    return `ws://${u.slice(7)}`;
  }
  return u;
}

let cachedProxyWs: string | null = null;

export function getApiUrl(): string {
  if (typeof window !== "undefined" && shouldUseApiProxy()) {
    return `${window.location.origin}/api/ride`;
  }
  const base = rawApi || "http://127.0.0.1:8000";
  return httpsIfSecurePage(base);
}

export function getGrabBaseUrl(): string {
  return process.env.NEXT_PUBLIC_GRABMAPS_BASE_URL?.replace(/\/$/, "") || "";
}

export function getGrabPublicKey(): string {
  return process.env.NEXT_PUBLIC_GRABMAPS_API_KEY || "";
}

/**
 * Synchronous WSS/WS base when proxy is not used (or during SSR as fallback).
 */
export function getWsBaseSyncFromApiUrl(): string {
  if (rawWs) return rawWs;
  return httpToWebSocketBase(rawApi || "http://127.0.0.1:8000");
}

/**
 * For WebSocket URL: on production with same-origin API proxy, ask the server for wss (cached).
 */
export async function getBackendWsBase(): Promise<string> {
  if (rawWs) return rawWs;
  if (typeof window === "undefined") {
    return getWsBaseSyncFromApiUrl();
  }
  if (shouldUseApiProxy()) {
    if (cachedProxyWs) return cachedProxyWs;
    const r = await fetch("/api/ride-ws-origin", { cache: "no-store" });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(
        `Could not load WebSocket config (${r.status}). ` +
          (errText || "Set RIDE_API_UPSTREAM on the server to your public FastAPI https URL."),
      );
    }
    const data = (await r.json()) as { wsBase?: string };
    if (!data.wsBase) throw new Error("Invalid /api/ride-ws-origin response");
    cachedProxyWs = data.wsBase;
    return data.wsBase;
  }
  return httpToWebSocketBase(getApiUrl());
}

export function tripWsUrl(tripId: string, wsBase: string): string {
  return `${wsBase.replace(/\/$/, "")}/ws/trips/${tripId}`;
}
