"use client";

import { useActionState } from "react";
import { issueLinkAction, type LinkState } from "@/lib/ops/admin-actions";
import { LinkResult } from "./link-result";

/** "New password link" on a user's page: the link appears here once, never in the address bar. */
export function IssueLinkForm({
  lang,
  staffId,
  t,
}: {
  lang: string;
  staffId: string;
  t: { newLink: string; working: string; linkReady: string; linkEmailed: string; linkNotEmailed: string; copy: string; copied: string; errors: Record<string, string> };
}) {
  const [state, action, pending] = useActionState<LinkState, FormData>(issueLinkAction, null);
  return (
    <div className="space-y-3">
      <form action={action}>
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="staffId" value={staffId} />
        <button type="submit" disabled={pending} className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-sand disabled:opacity-60">
          {pending ? t.working : t.newLink}
        </button>
      </form>
      {state?.ok ? <LinkResult url={state.url} emailed={state.emailed} name={state.name} email={state.email} t={t} /> : null}
      {state && !state.ok ? <p role="alert" className="text-sm text-danger">{t.errors[state.error] ?? t.errors.invalid}</p> : null}
    </div>
  );
}
