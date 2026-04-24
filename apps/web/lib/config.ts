const api = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://127.0.0.1:8000";

export function getApiUrl(): string {
  return api;
}

export function getWsBase(): string {
  return (
    process.env.NEXT_PUBLIC_WS_URL ||
    (api.startsWith("https") ? api.replace("https", "wss") : api.replace("http", "ws"))
  );
}

export function tripWsUrl(tripId: string): string {
  return `${getWsBase()}/ws/trips/${tripId}`;
}

export function getGrabBaseUrl(): string {
  return process.env.NEXT_PUBLIC_GRABMAPS_BASE_URL?.replace(/\/$/, "") || "";
}

export function getGrabPublicKey(): string {
  return process.env.NEXT_PUBLIC_GRABMAPS_API_KEY || "";
}
