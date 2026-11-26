"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorNote, Field, PrimaryButton } from "@/components/ui";
import type { Dictionary } from "@/i18n/get-dictionary";
import type { Locale } from "@/i18n/config";
import { authClient, authErrorKind, navigateAfterAuthChange } from "@/lib/auth/client";

export function LoginForm({ lang, t }: { lang: Locale; t: Dictionary["auth"] }) {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("error");
  const [error, setError] = useState<string | null>(initial === "no_staff" ? t.errors.noStaff : initial === "demo_off" ? t.errors.demoOff : null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (error) {
      setError(t.errors[authErrorKind(error)]);
      setBusy(false);
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      router.push(`/${lang}/ops/login/verify`);
      return;
    }
    navigateAfterAuthChange(`/${lang}/ops`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label={t.email} name="email" type="email" autoComplete="username" required />
      <Field label={t.password} name="password" type="password" autoComplete="current-password" required />
      <ErrorNote>{error}</ErrorNote>
      <PrimaryButton type="submit" disabled={busy}>
        {busy ? t.working : t.signIn}
      </PrimaryButton>
    </form>
  );
}
