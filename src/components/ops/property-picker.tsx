"use client";

import { Check, ChevronDown, MapPin, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

export type PickerOption = { href: string; label: string; active: boolean; closed?: boolean };

/**
 * Chooses the property a page shows: a button with the current choice and a
 * list that stays tidy with many properties (search from 7 up, closed
 * properties grouped at the bottom). Each choice is a link, so the choice
 * lives in the address like before.
 */
export function PropertyPicker({
  label,
  all,
  options,
  t,
  align = "end",
  className = "",
}: {
  /** What is being chosen, for screen readers ("Property"). */
  label: string;
  /** The "all properties" choice, when the page has one. */
  all?: { href: string; label: string; active: boolean };
  options: PickerOption[];
  t: { search: string; closed: string; noMatch: string };
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = all?.active ? all : options.find((o) => o.active);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const match = (o: { label: string }) => !q || o.label.toLowerCase().includes(q);
  const openOnes = options.filter((o) => !o.closed && match(o));
  const closedOnes = options.filter((o) => o.closed && match(o));
  const showAll = all && match(all);
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const item = (o: { href: string; label: string; active: boolean }, key: string) => (
    <li key={key}>
      <Link
        href={o.href}
        onClick={close}
        aria-current={o.active ? "page" : undefined}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${o.active ? "bg-lagoon-soft font-medium text-lagoon" : "text-ink hover:bg-sand/60"}`}
      >
        <span className="min-w-0 flex-1 truncate">{o.label}</span>
        {o.active ? <Check className="size-4 shrink-0" aria-hidden /> : null}
      </Link>
    </li>
  );

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full min-w-48 items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-left text-sm text-ink shadow-sm hover:border-lagoon/40"
      >
        <MapPin className="size-4 shrink-0 text-lagoon" aria-hidden />
        <span className="sr-only">{label}: </span>
        <span className="min-w-0 flex-1 truncate font-medium">{current?.label ?? label}</span>
        <ChevronDown className={`size-4 shrink-0 text-stone transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open ? (
        <div id={listId} className={`absolute z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-white p-2 shadow-xl ${align === "end" ? "right-0" : "left-0"}`}>
          {options.length > 6 ? (
            <label className="mb-2 flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 focus-within:border-lagoon">
              <Search className="size-4 text-stone" aria-hidden />
              <span className="sr-only">{t.search}</span>
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.search} className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none" />
            </label>
          ) : null}
          <ul className="max-h-80 space-y-0.5 overflow-y-auto">
            {showAll ? item(all, "all") : null}
            {showAll && openOnes.length ? <li aria-hidden className="my-1 border-t border-line/70" /> : null}
            {openOnes.map((o) => item(o, o.href))}
            {closedOnes.length ? (
              <li className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone" aria-hidden>
                {t.closed}
              </li>
            ) : null}
            {closedOnes.map((o) => item(o, o.href))}
            {!showAll && !openOnes.length && !closedOnes.length ? <li className="px-3 py-2 text-sm text-stone">{t.noMatch}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
