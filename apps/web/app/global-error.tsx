"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    window.location.replace("/");
  }, [error]);

  return (
    <html lang="en">
      <body className="m-0 flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-400">
        Returning to home…
      </body>
    </html>
  );
}
