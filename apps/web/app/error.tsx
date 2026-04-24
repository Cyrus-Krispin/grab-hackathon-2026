"use client";

import { useEffect } from "react";

export default function Error({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    window.location.replace("/");
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center bg-zinc-950 text-sm text-zinc-400">
      Returning to home…
    </div>
  );
}
