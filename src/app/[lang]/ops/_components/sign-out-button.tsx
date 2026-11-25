"use client";

import { useState } from "react";
import type { Locale } from "@/i18n/config";
import { authClient, navigateAfterAuthChange } from "@/lib/auth/client";

export function SignOutButton({ lang, label }: { lang: Locale; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        navigateAfterAuthChange(`/${lang}/ops/login`);
      }}
      className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-sand disabled:opacity-60"
    >
      {label}
    </button>
  );
}
