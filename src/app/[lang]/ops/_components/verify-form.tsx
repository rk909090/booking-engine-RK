"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ErrorNote, Field, PrimaryButton } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { authClient, authErrorKind, navigateAfterAuthChange } from "@/lib/auth/client";

export function VerifyForm({ lang, t }: { lang: Locale; t: Dictionary["auth"] }) {
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    setBusy(true);
    setError(null);
    const { error } =
      mode === "totp"
        ? await authClient.twoFactor.verifyTotp({ code })
        : await authClient.twoFactor.verifyBackupCode({ code });
    if (error) {
      const kind = authErrorKind(error);
      setError(t.errors[kind === "invalidCredentials" ? "invalidCode" : kind]);
      setBusy(false);
      return;
    }
    navigateAfterAuthChange(`/${lang}/ops`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {mode === "backup" ? <p className="text-sm text-stone">{t.backupCodeIntro}</p> : null}
      <Field
        key={mode}
        label={t.code}
        name="code"
        autoComplete="one-time-code"
        inputMode={mode === "totp" ? "numeric" : "text"}
        pattern={mode === "totp" ? "[0-9]{6}" : undefined}
        maxLength={mode === "totp" ? 6 : 64}
        required
        autoFocus
      />
      <ErrorNote>{error}</ErrorNote>
      <PrimaryButton type="submit" disabled={busy}>
        {busy ? t.working : t.verify}
      </PrimaryButton>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-lagoon underline-offset-4 hover:underline"
          onClick={() => {
            setMode(mode === "totp" ? "backup" : "totp");
            setError(null);
          }}
        >
          {mode === "totp" ? t.useBackupCode : t.useAuthenticator}
        </button>
        <Link href={`/${lang}/ops/login`} className="text-stone underline-offset-4 hover:underline">
          {t.backToLogin}
        </Link>
      </div>
    </form>
  );
}
