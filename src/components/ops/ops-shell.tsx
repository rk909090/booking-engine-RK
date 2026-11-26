import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import type { StaffProfile } from "@/lib/auth/staff";

/** Badge for a reservation status. */
export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone =
    status === "confirmed" || status === "in_house"
      ? "bg-success/10 text-success"
      : status === "hold"
        ? "bg-sand text-terracotta-deep"
        : status === "cancelled" || status === "no_show" || status === "expired"
          ? "bg-danger/10 text-danger"
          : "bg-lagoon-soft text-lagoon";
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

/** Shown instead of a page the signed-in role may not open. */
// lang and staff are kept so existing calls stay unchanged.
export function NoAccess({ dict }: { lang: Locale; dict: Dictionary; staff: StaffProfile }) {
  return (
    <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      {dict.resDetail.roleNotAllowed}
    </p>
  );
}
