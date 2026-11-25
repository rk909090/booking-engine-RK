import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/app/[lang]/ops/_components/sign-out-button";
import { brand } from "@/config/brand";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import type { StaffProfile } from "@/lib/auth/staff";
import { can, type Action } from "@/lib/authz/permissions";

/** Static frame of the staff area; the session-dependent part renders inside. */
export function OpsShell({ lang, dict, children }: { lang: Locale; dict: Dictionary; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line bg-lagoon text-ivory">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href={`/${lang}/ops`} className="font-display text-lg">
            {brand.name} <span className="text-sm text-ivory/70">· {dict.ops.title}</span>
          </Link>
        </div>
      </header>
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}

type NavKey = "home" | "reservations" | "calendar" | "villaStatus";
const items: Array<{ key: NavKey; href: string; action: Action }> = [
  { key: "home", href: "", action: "dashboard.view" },
  { key: "reservations", href: "/reservations", action: "reservation.view" },
  { key: "calendar", href: "/calendar", action: "calendar.view" },
  { key: "villaStatus", href: "/villa-status", action: "villa_status.view" },
];

/** Navigation for the signed-in staff member; items follow their role. */
export function OpsNav({ lang, dict, staff, current }: { lang: Locale; dict: Dictionary; staff: StaffProfile; current: NavKey }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
      <nav aria-label={dict.opsNav.menu} className="flex flex-wrap gap-1">
        {items
          .filter((i) => can(staff.actor, i.action).allowed)
          .map((i) => (
            <Link
              key={i.key}
              href={`/${lang}/ops${i.href}`}
              aria-current={i.key === current ? "page" : undefined}
              className={
                i.key === current
                  ? "rounded-lg bg-lagoon px-3 py-1.5 text-sm text-ivory"
                  : "rounded-lg px-3 py-1.5 text-sm text-ink hover:bg-sand"
              }
            >
              {dict.opsNav[i.key]}
            </Link>
          ))}
      </nav>
      <div className="flex items-center gap-2 text-sm">
        <span className="hidden text-stone sm:inline">
          {staff.fullName} · {dict.ops.roles[staff.role]}
        </span>
        <Link href={`/${lang}/ops/security`} className="rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-sand">
          {dict.ops.security}
        </Link>
        <SignOutButton lang={lang} label={dict.ops.signOut} />
      </div>
    </div>
  );
}

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
export function NoAccess({ lang, dict, staff }: { lang: Locale; dict: Dictionary; staff: StaffProfile }) {
  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="home" />
      <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
        {dict.resDetail.roleNotAllowed}
      </p>
    </>
  );
}
