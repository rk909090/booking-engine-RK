"use client";

import { useActionState } from "react";
import { ErrorNote, Field, PrimaryButton } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { lookupBooking, type LookupState } from "@/lib/booking/actions";

export function LookupForm({ lang, t, errors }: { lang: Locale; t: Dictionary["booking"]; errors: Dictionary["checkout"]["errors"] }) {
  const [state, action, pending] = useActionState<LookupState, FormData>(lookupBooking, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="lang" value={lang} />
      <Field label={t.code} name="code" required autoComplete="off" placeholder="ATR-XXXXXXXX" maxLength={20} />
      <Field label={t.email} name="email" type="email" required autoComplete="email" maxLength={200} />
      <ErrorNote>{state.notFound ? t.notFound : state.rateLimited ? errors.rate_limited : null}</ErrorNote>
      <PrimaryButton type="submit" disabled={pending}>
        {t.find}
      </PrimaryButton>
    </form>
  );
}
