import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ride Comfort Intelligence — Grab",
  description: "Route-aware comfort and safety intelligence for Grab rides",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full flex flex-col overflow-hidden">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
