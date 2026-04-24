import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Agent } from "undici";

export const dynamic = "force-dynamic";

const raw = (process.env.RIDE_API_UPSTREAM || process.env.BACKEND_URL || "").trim();
const UP = raw.replace(/\/$/, "");

const RIDE_API_TLS_INSECURE =
  process.env.RIDE_API_TLS_INSECURE === "1" || process.env.RIDE_API_TLS_INSECURE === "true";

const rideInsecureAgent = RIDE_API_TLS_INSECURE
  ? new Agent({ connect: { rejectUnauthorized: false } })
  : undefined;

function resolveUpstream(): string | null {
  if (!UP) return null;
  if (UP.includes("://")) return UP;
  return `https://${UP}`;
}

function serializeFetchError(e: unknown): { message: string; cause?: string; code?: string } {
  const err = e as { message?: string; cause?: unknown; code?: string };
  return {
    message: err?.message ?? String(e),
    cause: err?.cause != null ? String(err.cause) : undefined,
    code: err?.code,
  };
}

async function handle(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const ride = resolveUpstream();
  if (!ride) {
    return NextResponse.json(
      {
        detail:
          "RIDE_API_UPSTREAM (or BACKEND_URL) is not set. In Vercel, set it to your public FastAPI base URL, e.g. https://54-169-70-247.sslip.io",
      },
      { status: 503 },
    );
  }
  const { path } = await context.params;
  const segments = path ?? [];
  const pathPart = segments.length ? `/${segments.join("/")}` : "";
  const target = new URL(pathPart, `${ride}/`);
  const inc = new URL(req.url);
  target.search = inc.search;

  const method = req.method;
  const headers = new Headers();
  for (const h of ["content-type", "accept", "accept-language", "authorization"] as const) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Nginx may gzip; we do not forward content-encoding, so require uncompressed from upstream.
  headers.set("accept-encoding", "identity");

  const init: RequestInit = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  const fetchInit = {
    ...init,
    dispatcher:
      rideInsecureAgent && ride.startsWith("https:") ? rideInsecureAgent : undefined,
  } as RequestInit & { dispatcher?: typeof rideInsecureAgent };

  let res: Response;
  try {
    res = await fetch(target, fetchInit);
  } catch (e) {
    const se = serializeFetchError(e);
    return NextResponse.json(
      {
        detail:
          "Proxy could not reach the ride API. If the host uses a self-signed cert (e.g. nginx reset after deploy), set RIDE_API_TLS_INSECURE=1 on Vercel, or re-apply Let’s Encrypt on the server.",
        upstream: target.href,
        error: se.message,
        cause: se.cause,
        code: se.code,
      },
      { status: 502 },
    );
  }

  const out = new NextResponse(res.body, { status: res.status });
  res.headers.forEach((value, key) => {
    if (key === "content-encoding" || key === "transfer-encoding") return;
    out.headers.set(key, value);
  });
  return out;
}

export { handle as GET, handle as POST, handle as DELETE, handle as PUT, handle as PATCH, handle as HEAD };
