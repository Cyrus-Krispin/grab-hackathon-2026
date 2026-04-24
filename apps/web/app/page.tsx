"use client";

import { RideConsole } from "@/components/RideConsole";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl">
        <RideConsole />
      </div>
    </div>
  );
}
