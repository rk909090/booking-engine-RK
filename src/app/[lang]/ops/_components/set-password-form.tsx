"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorNote, Field, PrimaryButton, SuccessNote } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import type { Dictionary } from "@/i18n/get-dictionary";
import { authClient, authErrorKind } from "@/lib/auth/client";

export function SetPasswordForm({
  lang,
  t,
  minLength,
}: {
  lang: Locale;
  t: Dictionary["auth"];
  minLength: number;
}) {
  const token = useSearchParams().get("token");
  const [error, setError] = useState<string | null>(token ? null : t.errors.missingToken);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError(t.errors.passwordsDoNotMatch);
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (error) {
      setError(error.status === 400 && !error.code?.includes("PASSWORD") ? t.errors.missingToken : t.errors[authErrorKind(error)]);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="space-y-4">
        <SuccessNote>{t.passwordSaved}</SuccessNote>
        <Link
          href={`/${lang}/ops/login`}
          className="block rounded-lg bg-lagoon px-4 py-2.5 text-center font-medium text-ivory hover:bg-lagoon-deep"
        >
          {t.goToLogin}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field
        label={t.newPassword}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={minLength}
        hint={format(t.passwordHint, { min: minLength })}
        required
        disabled={!token}
      />
      <Field
        label={t.confirmPassword}
        name="confirm"
        type="password"
        autoComplete="new-password"
        minLength={minLength}
        required
        disabled={!token}
      />
      <ErrorNote>{error}</ErrorNote>
      <PrimaryButton type="submit" disabled={busy || !token}>
        {busy ? t.working : t.savePassword}
      </PrimaryButton>
    </form>
  );
}
