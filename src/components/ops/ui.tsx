import Link from "next/link";
import type { ReactNode } from "react";

/*
 * Building blocks of the staff working area (the newer pages): page header,
 * white cards on the canvas, figure tiles. Colours come from the tokens in
 * globals.css.
 */

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-terracotta-deep">{eyebrow}</div> : null}
        <h1 className="font-display text-2xl text-ink sm:text-3xl">{title}</h1>
        {description ? <div className="mt-1 max-w-3xl text-sm text-stone">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
  bodyClassName = "p-5",
  id,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-6 rounded-2xl border border-line/80 bg-white shadow-sm ${className}`}>
      {title || action ? (
        <div className="flex items-center justify-between gap-3 border-b border-line/70 px-5 py-3.5">
          {title ? <h2 className="text-sm font-semibold text-ink">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** A small link in a card header ("View all →"). */
export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-xs font-medium text-lagoon hover:underline">
      {children} →
    </Link>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "info"; children: ReactNode }) {
  const tones = {
    neutral: "bg-sand text-ink",
    good: "bg-success/10 text-success",
    warn: "bg-terracotta/15 text-terracotta-deep",
    bad: "bg-danger/10 text-danger",
    info: "bg-lagoon-soft text-lagoon",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export const primaryButton = "inline-flex items-center gap-2 rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep disabled:opacity-60";
export const secondaryButton = "inline-flex items-center gap-2 rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-sand disabled:opacity-60";
export const dangerButton = "inline-flex items-center gap-2 rounded-lg border border-danger/40 bg-white px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5 disabled:opacity-60";
export const inputClass = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-lagoon focus:outline-none focus:ring-2 focus:ring-lagoon/20 disabled:bg-sand/40 disabled:text-stone";
export const labelClass = "block space-y-1 text-xs font-medium text-stone";
/** An input in a row of filters (sized by its content, not the full width). */
export const filterClass = "rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-lagoon focus:outline-none focus:ring-2 focus:ring-lagoon/20";

/** Segmented links (property switcher, tabs). */
export function Segmented({ items, label }: { items: Array<{ href: string; label: string; active: boolean }>; label: string }) {
  return (
    <nav aria-label={label} className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.active ? "page" : undefined}
          className={`rounded-lg px-3 py-1.5 text-sm ${i.active ? "bg-lagoon text-ivory" : "text-ink hover:bg-sand"}`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
