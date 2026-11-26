"use client";

import { useState, type FormEvent } from "react";
import { ErrorNote, Field } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { authClient, authErrorKind, navigateAfterAuthChange } from "@/lib/auth/client";

/** Turns the signed-in account's authenticator off (needs the password). Only offered while 2FA is not required. */
export function TwoFactorDisable({ lang, t, authT }: { lang: Locale; t: Dictionary["security"]; authT: Dictionary["auth"] }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    setBusy(true);
    setError(null);
    const { error } = await authClient.twoFactor.disable({ password });
    if (error) {
      setError(authT.errors[authErrorKind(error)]);
      setBusy(false);
      return;
    }
    navigateAfterAuthChange(`/${lang}/ops/security?disabled=1`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold text-ink">{t.disableTitle}</h2>
      <p className="text-xs text-stone">{t.disableIntro}</p>
      <Field label={authT.password} name="password" type="password" autoComplete="current-password" required />
      <ErrorNote>{error}</ErrorNote>
      <button type="submit" disabled={busy} className="w-full rounded-lg border border-danger/40 bg-white px-4 py-2.5 font-medium text-danger hover:bg-danger/5 disabled:opacity-60">
        {busy ? authT.working : t.disable}
      </button>
    </form>
  );
}
