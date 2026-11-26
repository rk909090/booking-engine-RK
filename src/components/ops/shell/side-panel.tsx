"use client";

import { Maximize2, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/*
 * The right-hand detail panel. A link to a reservation, guest, task or user
 * is intercepted into the @panel slot, so the page underneath stays visible
 * and the URL is the detail's own (shareable; a reload shows the full page).
 *
 * A slot keeps its content when the next page has nothing for it, so the
 * panel hides itself as soon as the address is no longer its own. "Close"
 * goes back to the last page that was not a detail: actions inside the panel
 * add history entries, so the browser's back would only reopen the detail.
 */

const TRAIL_KEY = "ops-trail";

/** Addresses that open in the panel (the details); everything else is a page. */
export function isDetailPath(pathname: string): boolean {
  return /^\/(id|en)\/ops\/(reservations|guests|tasks|users)\/[^/]+$/.test(pathname);
}

/** Rendered once by the layout: remembers the pages visited in this tab. */
export function NavTrail() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    const query = search.toString();
    const here = query ? `${pathname}?${query}` : pathname;
    try {
      const trail: string[] = JSON.parse(sessionStorage.getItem(TRAIL_KEY) ?? "[]");
      if (trail[trail.length - 1] !== here) trail.push(here);
      sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-30)));
    } catch {
      // Storage unavailable (private mode): closing falls back to the list.
    }
  }, [pathname, search]);
  return null;
}

function lastPage(): string | null {
  try {
    const trail: string[] = JSON.parse(sessionStorage.getItem(TRAIL_KEY) ?? "[]");
    for (let i = trail.length - 1; i >= 0; i--) if (!isDetailPath(trail[i].split("?")[0])) return trail[i];
  } catch {
    return null;
  }
  return null;
}

export function SidePanel({
  title,
  detailPath,
  fallbackHref,
  labels,
  children,
}: {
  title: string;
  /** The detail's own address (also its full page). */
  detailPath: string;
  /** Where "close" goes when no earlier page is known (the list of this kind). */
  fallbackHref: string;
  labels: { close: string; openFull: string };
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const ref = useRef<HTMLElement>(null);
  const shown = pathname === detailPath;

  useEffect(() => {
    if (!shown) return;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) router.replace(lastPage() ?? fallbackHref, { scroll: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown, router, fallbackHref]);

  if (!shown) return null;
  const close = () => router.replace(lastPage() ?? fallbackHref, { scroll: false });

  return (
    <>
      {/* Dims the page on phones and tablets, where the panel covers it. */}
      <button type="button" aria-label={labels.close} onClick={close} className="fixed inset-0 z-40 bg-ink/30 xl:hidden" />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={title}
        className="@container fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-white shadow-2xl outline-none sm:w-[min(760px,92vw)] xl:w-[min(860px,52vw)]"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</p>
          {/* A full load shows the page itself rather than the panel again. */}
          <a href={detailPath} title={labels.openFull} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-stone hover:bg-sand hover:text-ink">
            <Maximize2 className="size-4" aria-hidden />
            <span className="hidden sm:inline">{labels.openFull}</span>
          </a>
          <button type="button" onClick={close} className="rounded-lg p-2 text-stone hover:bg-sand hover:text-ink" aria-label={labels.close} title={labels.close}>
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
      </aside>
    </>
  );
}

/** The panel's frame while its content loads. */
export function PanelSkeleton({ label }: { label: string }) {
  return (
    <aside aria-busy="true" className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-white shadow-2xl sm:w-[min(760px,92vw)] xl:w-[min(860px,52vw)]">
      <div className="h-14 shrink-0 border-b border-line" />
      <p className="px-6 py-5 text-sm text-stone">{label}</p>
    </aside>
  );
}
