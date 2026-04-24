import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const raw = (process.env.RIDE_API_UPSTREAM || process.env.BACKEND_URL || "").trim();
const UP = raw.replace(/\/$/, "");

function resolveUpstream(): string | null {
  if (!UP) return null;
  if (UP.includes("://")) return UP;
  return `https://${UP}`;
}

async function handle(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const ride = resolveUpstream();
  if (!ride) {
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

  const res = await fetch(target, init);
  const out = new NextResponse(res.body, { status: res.status });
  res.headers.forEach((value, key) => {
    if (key === "content-encoding" || key === "transfer-encoding") return;
    out.headers.set(key, value);
  });
  return out;
}

export { handle as GET, handle as POST, handle as DELETE, handle as PUT, handle as PATCH, handle as HEAD };
