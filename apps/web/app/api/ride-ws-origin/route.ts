import { NextResponse } from "next/server";

const raw = (process.env.RIDE_API_UPSTREAM || process.env.BACKEND_URL || "").trim();
const UP = raw.replace(/\/$/, "");

function withHttpScheme(base: string): string {
  if (base.includes("://")) return base;
  return `https://${base}`;
}

function toWsBase(httpBase: string): string | null {
  const b = withHttpScheme(httpBase);
  if (b.startsWith("https://")) return `wss://${b.slice(8)}`;
  if (b.startsWith("http://")) {
    const rest = b.slice(7);
    if (rest.startsWith("localhost:") || rest.startsWith("127.0.0.1:")) {
      return `ws://${rest}`;
    }
    return `wss://${rest}`;
  }
  return null;
}

export function GET() {
  if (!UP) {
    return NextResponse.json(
      { error: "RIDE_API_UPSTREAM is not set on the server" },
      { status: 503 },
    );
  }
  const wsBase = toWsBase(UP);
  if (!wsBase) {
    return NextResponse.json({ error: "Invalid RIDE_API_UPSTREAM" }, { status: 500 });
  }
  return NextResponse.json({ wsBase });
}
