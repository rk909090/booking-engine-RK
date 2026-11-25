import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { brand } from "@/config/brand";

/** Centered card used by the sign-in, verification and password pages. */
export function AuthCard({
  eyebrow,
  title,
  intro,
  homeHref,
  children,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  homeHref: string;
  children: ReactNode;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link href={homeHref} className="font-display text-xl text-lagoon">
          {brand.name}
        </Link>
        <div className="mt-6 rounded-2xl border border-line bg-white/70 p-6 shadow-sm sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-terracotta-deep">{eyebrow}</p>
          <h1 className="mt-2 font-display text-3xl text-lagoon">{title}</h1>
          {intro ? <p className="mt-3 text-sm leading-relaxed text-stone">{intro}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & ComponentProps<"input">) {
  const id = input.id ?? input.name;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        {...input}
        className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink outline-none focus:border-lagoon focus:ring-2 focus:ring-lagoon/20"
      />
      {hint ? <p className="text-xs leading-relaxed text-stone">{hint}</p> : null}
    </div>
  );
}

export function PrimaryButton({ children, ...props }: ComponentProps<"button">) {
  return (
    <button
      {...props}
      className="w-full rounded-lg bg-lagoon px-4 py-2.5 font-medium text-ivory transition hover:bg-lagoon-deep disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
      {children}
    </p>
  );
}
