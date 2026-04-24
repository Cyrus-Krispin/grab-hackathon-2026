import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const raw = (process.env.RIDE_API_UPSTREAM || process.env.BACKEND_URL || "").trim();
const UP = raw.replace(/\/$/, "");

// #region agent log
const __dbg = (location: string, message: string, data: Record<string, unknown>, hypothesisId: string) => {
  void fetch("http://127.0.0.1:7880/ingest/ff5ed5c1-ec83-4529-bdaf-8afcc881e265", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "f34b8e" },
    body: JSON.stringify({
      sessionId: "f34b8e",
      location,
      message,
      data: { ...data, hypothesisId },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
};
// #endregion

function resolveUpstream(): string | null {
  if (!UP) return null;
  if (UP.includes("://")) return UP;
  return `https://${UP}`;
}

async function handle(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const ride = resolveUpstream();
  if (!ride) {
    // #region agent log
    __dbg("ride/[...path]/route.ts:handle", "ride-proxy-no-upstream", { hasRaw: Boolean(raw), upLen: UP.length }, "H2");
    // #endregion
    return NextResponse.json(
      {
        detail:
          "RIDE_API_UPSTREAM (or BACKEND_URL) is not set. In Vercel, set it to your public FastAPI base URL, e.g. https://your-api.railway.app",
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

  const init: RequestInit = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  // #region agent log
  __dbg(
    "ride/[...path]/route.ts:handle",
    "ride-proxy-pre-fetch",
    {
      targetHref: target.href,
      ride,
      method,
      tlsInsecureEnv: process.env.RIDE_API_TLS_INSECURE ?? "(unset)",
    },
    "H3",
  );
  // #endregion

  let res: Response;
  try {
    res = await fetch(target, init);
  } catch (e) {
    const err = e as { message?: string; name?: string; cause?: unknown; code?: string };
    // #region agent log
    __dbg(
      "ride/[...path]/route.ts:handle",
      "ride-proxy-fetch-threw",
      {
        errName: err?.name,
        errMessage: err?.message,
        errCode: err?.code,
        cause: err?.cause != null ? String(err.cause) : undefined,
      },
      "H1",
    );
    // #endregion
    throw e;
  }

  // #region agent log
  __dbg(
    "ride/[...path]/route.ts:handle",
    "ride-proxy-fetch-ok",
    { status: res.status, ok: res.ok },
    "H5",
  );
  // #endregion
  const out = new NextResponse(res.body, { status: res.status });
  res.headers.forEach((value, key) => {
    if (key === "content-encoding" || key === "transfer-encoding") return;
    out.headers.set(key, value);
  });
  return out;
}

export { handle as GET, handle as POST, handle as DELETE, handle as PUT, handle as PATCH, handle as HEAD };
