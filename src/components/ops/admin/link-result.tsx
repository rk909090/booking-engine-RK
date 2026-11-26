"use client";

import { CopyField } from "@/components/ops/copy-field";
import { format } from "@/i18n/format";

/** Shows a one-time password link once, with how to hand it over. */
export function LinkResult({
  url,
  emailed,
  name,
  email,
  t,
}: {
  url: string;
  emailed: boolean;
  name: string;
  email: string;
  t: { linkReady: string; linkEmailed: string; linkNotEmailed: string; copy: string; copied: string };
}) {
  return (
    <div role="status" className="space-y-2 rounded-xl border border-success/30 bg-success/5 p-4 text-sm text-ink">
      <p>{format(t.linkReady, { name })}</p>
      <CopyField value={url} copyLabel={t.copy} copiedLabel={t.copied} />
      <p className={emailed ? "text-success" : "text-terracotta-deep"}>{emailed ? format(t.linkEmailed, { email }) : t.linkNotEmailed}</p>
    </div>
  );
}
