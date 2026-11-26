"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { inputClass, labelClass, primaryButton, secondaryButton } from "@/components/ops/ui";
import { format } from "@/i18n/format";
import { inviteUserAction, type LinkState } from "@/lib/ops/admin-actions";
import { LinkResult } from "./link-result";

type T = {
  fullName: string;
  email: string;
  roleLabel: string;
  propertiesLabel: string;
  propertiesHint: string;
  submit: string;
  working: string;
  done: string;
  openProfile: string;
  another: string;
  linkReady: string;
  linkEmailed: string;
  linkNotEmailed: string;
  copy: string;
  copied: string;
  errors: Record<string, string>;
};

/** Invite a staff member: name, email, role and properties; their one-time link is shown once afterwards. */
export function InviteForm({
  lang,
  roles,
  properties,
  t,
}: {
  lang: string;
  roles: Array<{ value: string; label: string }>;
  properties: Array<{ slug: string; name: string }>;
  t: T;
}) {
  const [state, action, pending] = useActionState<LinkState, FormData>(inviteUserAction, null);
  const [role, setRole] = useState("front_office");

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <p className="text-sm font-medium text-ink">{format(t.done, { name: state.name })}</p>
        <LinkResult url={state.url} emailed={state.emailed} name={state.name} email={state.email} t={t} />
        <div className="flex flex-wrap gap-2">
          <Link href={`/${lang}/ops/users/${state.staffId}`} className={primaryButton}>
            {t.openProfile}
          </Link>
          {/* A full load gives an empty form again. */}
          <a href={`/${lang}/ops/users/new`} className={secondaryButton}>
            {t.another}
          </a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="lang" value={lang} />
      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {t.errors[state.error] ?? t.errors.invalid}
        </p>
      ) : null}
      <label className={labelClass}>
        <span>{t.fullName}</span>
        <input name="fullName" required minLength={2} maxLength={120} autoComplete="off" className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>{t.email}</span>
        <input name="email" type="email" required maxLength={200} autoComplete="off" className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>{t.roleLabel}</span>
        <select name="role" value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {role !== "director" ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-stone">{t.propertiesLabel}</legend>
          <div className="flex flex-wrap gap-3">
            {properties.map((p) => (
              <label key={p.slug} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink">
                <input type="checkbox" name="property" value={p.slug} className="size-4 accent-lagoon" />
                {p.name}
              </label>
            ))}
          </div>
          <p className="text-xs text-stone">{t.propertiesHint}</p>
        </fieldset>
      ) : null}
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? t.working : t.submit}
      </button>
    </form>
  );
}
