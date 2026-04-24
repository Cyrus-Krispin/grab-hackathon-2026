"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiUrl } from "@/lib/config";

export type PickedPlace = { id: string; label: string; lat: number; lng: number };

type Props = {
  label: string;
  value: PickedPlace | null;
  onChange: (p: PickedPlace | null) => void;
  disabled?: boolean;
};

export function SingaporePlaceField({ label, value, onChange, disabled }: Props) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PickedPlace[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const inputText = value?.label ?? draft;

  useEffect(() => {
    const searchQ = inputText.trim();
    let cancelled = false;

    const run = async () => {
      if (searchQ.length < 2) {
        await new Promise((r) => setTimeout(r, 0));
        if (!cancelled) {
          setItems([]);
          setLoading(false);
        }
        return;
      }
      if (!cancelled) setLoading(true);
      await new Promise((r) => setTimeout(r, 320));
      if (cancelled) return;
      try {
        const res = await fetch(
          `${getApiUrl()}/places/search?q=${encodeURIComponent(searchQ)}&limit=8`,
        );
        const data = (await res.json()) as {
          places?: Array<{ id: string; label: string; lat: number; lng: number }>;
        };
        const places = (data.places ?? []).map((p) => ({
          id: String(p.id),
          label: p.label,
          lat: p.lat,
          lng: p.lng,
        }));
        if (!cancelled) setItems(places);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [inputText]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const pick = useCallback(
    (p: PickedPlace) => {
      onChange(p);
      setDraft("");
      setOpen(false);
    },
    [onChange],
  );

  return (
    <div ref={boxRef} className="relative">
      <label className="mb-1 block text-xs font-medium text-zinc-600">{label}</label>
      <input
        type="text"
        disabled={disabled}
        value={inputText}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search places in Singapore…"
        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[#00b14f] focus:outline-none focus:ring-1 focus:ring-[#00b14f]"
      />
      {open && (items.length > 0 || loading) && (
        <ul className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
          {loading && (
            <li className="px-3 py-2 text-xs text-zinc-500">Searching…</li>
          )}
          {!loading &&
            items.map((p) => (
              <li key={`${p.id}-${p.lat}-${p.lng}`}>
                <button
                  type="button"
                  onClick={() => pick(p)}
                  className="w-full px-3 py-2 text-left text-xs leading-snug text-zinc-800 hover:bg-zinc-50"
                >
                  {p.label}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
