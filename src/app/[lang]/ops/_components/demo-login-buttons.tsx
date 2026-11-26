"use client";

import { useState } from "react";
import { ErrorNote } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import { navigateAfterAuthChange } from "@/lib/auth/client";

type Props = {
  lang: Locale;
  roles: Array<{ role: string; label: string; hint: string }>;
  t: { title: string; intro: string; working: string; error: string; or: string };
};

export function DemoLoginButtons({ lang, roles, t }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(role: string) {
    setBusy(role);
    setError(null);
    try {
      const response = await fetch("/api/auth/demo-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (response.ok) {
        navigateAfterAuthChange(`/${lang}/ops`);
        return;
      }
    } catch {
      // Shown below.
    }
    setError(t.error);
    setBusy(null);
  }

  return (
    <section aria-labelledby="demo-login-title" className="mb-6 rounded-xl border border-terracotta/40 bg-terracotta/5 p-4">
      <h2 id="demo-login-title" className="text-sm font-semibold text-ink">
        {t.title}
      </h2>
      <p className="mt-1 text-xs text-stone">{t.intro}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {roles.map((r) => (
          <button
            key={r.role}
            type="button"
            onClick={() => signIn(r.role)}
            disabled={busy !== null}
            className="rounded-lg border border-line bg-white px-3 py-2 text-left hover:border-lagoon hover:bg-sand/40 disabled:opacity-60"
          >
            <span className="block text-sm font-medium text-ink">{busy === r.role ? t.working : r.label}</span>
            <span className="block text-xs text-stone">{r.hint}</span>
          </button>
        ))}
      </div>
      <div className="mt-2">
        <ErrorNote>{error}</ErrorNote>
      </div>
      <p className="mt-4 flex items-center gap-3 text-xs text-stone before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">{t.or}</p>
    </section>
  );
}
