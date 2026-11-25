"use client";

import QRCode from "qrcode";
import { useState, type FormEvent } from "react";
import { ErrorNote, Field, PrimaryButton } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { authClient, authErrorKind, navigateAfterAuthChange } from "@/lib/auth/client";

type Step =
  | { name: "password" }
  | { name: "scan"; qr: string; secret: string; backupCodes: string[] }
  | { name: "backup"; backupCodes: string[] };

export function TwoFactorSetup({
  lang,
  t,
  authT,
}: {
  lang: Locale;
  t: Dictionary["security"];
  authT: Dictionary["auth"];
}) {
  const [step, setStep] = useState<Step>({ name: "password" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.enable({ password, method: "totp" });
    if (error || !data || data.method !== "totp") {
      setError(authT.errors[authErrorKind(error)]);
      setBusy(false);
      return;
    }
    const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
    const qr = await QRCode.toDataURL(data.totpURI, { margin: 1, width: 224 });
    setStep({ name: "scan", qr, secret, backupCodes: data.backupCodes });
    setBusy(false);
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.name !== "scan") return;
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    setBusy(true);
    setError(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (error) {
      setError(authT.errors.invalidCode);
      return;
    }
    setStep({ name: "backup", backupCodes: step.backupCodes });
  }

  if (step.name === "password") {
    return (
      <form onSubmit={start} className="space-y-4">
        <p className="text-sm text-ink">{t.step1}</p>
        <Field label={authT.password} name="password" type="password" autoComplete="current-password" required />
        <ErrorNote>{error}</ErrorNote>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? authT.working : t.start}
        </PrimaryButton>
      </form>
    );
  }

  if (step.name === "scan") {
    return (
      <form onSubmit={activate} className="space-y-4">
        <p className="text-sm text-ink">{t.step2}</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated in the browser */}
        <img src={step.qr} alt={t.qrAlt} width={224} height={224} className="mx-auto rounded-lg border border-line bg-white" />
        <p className="text-xs text-stone">{t.manualKey}</p>
        <code className="block break-all rounded-lg bg-sand px-3 py-2 text-sm text-ink">{step.secret}</code>
        <p className="text-sm text-ink">{t.step3}</p>
        <Field
          label={authT.code}
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          autoComplete="one-time-code"
          required
        />
        <ErrorNote>{error}</ErrorNote>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? authT.working : t.activate}
        </PrimaryButton>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="font-display text-xl text-lagoon">{t.backupTitle}</h2>
      <p className="text-sm text-stone">{t.backupIntro}</p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-sand p-3 font-mono text-sm text-ink">
        {step.backupCodes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <PrimaryButton
        type="button"
        onClick={() => {
          navigateAfterAuthChange(`/${lang}/ops`);
        }}
      >
        {t.continue}
      </PrimaryButton>
    </div>
  );
}
