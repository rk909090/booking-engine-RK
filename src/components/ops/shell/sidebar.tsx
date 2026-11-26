import { cookies } from "next/headers";
import { brand } from "@/config/brand";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { NAV, SIDEBAR_COOKIE } from "./nav";
import { SidebarClient } from "./sidebar-client";

/** The menu for the signed-in staff member: only what their role may open. Reads the session, so render inside <Suspense>. */
export async function Sidebar({ lang, dict }: { lang: Locale; dict: Dictionary }) {
  // The account page must stay reachable before 2FA is set up; pages enforce 2FA themselves.
  const staff = await requireStaff(lang, { allowWithoutTwoFactor: true });
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
  const t = dict.opsNav;
  const groups = NAV.map((g) => ({
    key: g.group,
    label: t.groups[g.group],
    items: g.items.filter((i) => i.actions.some((a) => can(staff.actor, a).allowed)).map((i) => ({ key: i.key, href: `/${lang}/ops${i.href}`, label: t[i.key], also: (i.also ?? []).map((a) => `/${lang}/ops${a}`) })),
  })).filter((g) => g.items.length > 0);

  return (
    <SidebarClient
      lang={lang}
      groups={groups}
      user={{ name: staff.fullName, role: dict.ops.roles[staff.role] }}
      initialCollapsed={collapsed}
      labels={{
        brand: brand.name,
        title: dict.ops.title,
        menu: t.menu,
        collapse: t.collapse,
        expand: t.expand,
        openMenu: t.openMenu,
        closeMenu: t.closeMenu,
        security: dict.ops.security,
        signOut: dict.ops.signOut,
        language: t.language,
      }}
    />
  );
}

/** Same footprint as the sidebar while the session loads, so the page does not jump. */
export function SidebarSkeleton() {
  return (
    <>
      <div className="sticky top-0 z-30 h-14 bg-lagoon-deep lg:hidden" aria-hidden />
      <div className="sticky top-0 hidden h-dvh w-64 shrink-0 bg-lagoon-deep lg:block" aria-hidden />
    </>
  );
}
