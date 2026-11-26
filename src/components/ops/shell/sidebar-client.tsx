"use client";

import {
  BedDouble,
  Cable,
  CalendarCheck2,
  CalendarRange,
  ChartColumn,
  ClipboardList,
  KeyRound,
  Landmark,
  Languages,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Tags,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient, navigateAfterAuthChange } from "@/lib/auth/client";
import { SIDEBAR_COOKIE, type NavIcon } from "./nav";

const ICONS: Record<NavIcon, LucideIcon> = {
  home: LayoutDashboard,
  reservations: CalendarCheck2,
  calendar: CalendarRange,
  guests: Users,
  villaStatus: BedDouble,
  tasks: ClipboardList,
  reports: ChartColumn,
  rates: Tags,
  owners: Landmark,
  channels: Cable,
  users: UserCog,
  roles: ShieldCheck,
  settings: Settings,
};

export type SidebarGroup = { key: string; label: string; items: Array<{ key: NavIcon; href: string; label: string; also: string[] }> };
export type SidebarLabels = {
  brand: string;
  title: string;
  menu: string;
  collapse: string;
  expand: string;
  openMenu: string;
  closeMenu: string;
  security: string;
  signOut: string;
  language: string;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Collapsible left menu (wide screens) and slide-in menu (phones) of the staff area. */
export function SidebarClient({
  lang,
  groups,
  user,
  initialCollapsed,
  labels,
}: {
  lang: string;
  groups: SidebarGroup[];
  user: { name: string; role: string };
  initialCollapsed: boolean;
  labels: SidebarLabels;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  // The phone menu is open "on" a page: navigating closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const mobileOpen = openOn === pathname;
  const setMobileOpen = (open: boolean) => setOpenOn(open ? pathname : null);
  const [signingOut, setSigningOut] = useState(false);
  const base = `/${lang}/ops`;

  // Escape closes the phone menu; the page behind does not scroll while it is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenOn(null);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax`;
  };
  const under = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const isActive = (item: { href: string; also: string[] }) => (item.href === base ? pathname === base : under(item.href) || item.also.some(under));
  const otherLang = lang === "id" ? "en" : "id";
  const otherLangHref = pathname.replace(/^\/(id|en)(?=\/|$)/, `/${otherLang}`);

  const signOut = async () => {
    setSigningOut(true);
    await authClient.signOut();
    navigateAfterAuthChange(`/${lang}/ops/login`);
  };

  const body = (compact: boolean, onPhone: boolean) => (
    <>
      <div className={`flex h-16 shrink-0 items-center gap-3 border-b border-white/10 ${compact ? "justify-center px-2" : "px-4"}`}>
        <Link href={base} className="flex min-w-0 items-center gap-3" title={labels.brand}>
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-terracotta font-display text-lg text-ivory">
            {labels.brand.slice(0, 1)}
          </span>
          {compact ? (
            <span className="sr-only">{labels.brand}</span>
          ) : (
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-display text-base text-ivory">{labels.brand}</span>
              <span className="block text-xs text-ivory/60">{labels.title}</span>
            </span>
          )}
        </Link>
        {onPhone ? (
          <button type="button" onClick={() => setMobileOpen(false)} className="ml-auto rounded-lg p-2 text-ivory/80 hover:bg-white/10 hover:text-ivory" aria-label={labels.closeMenu}>
            <X className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      <nav aria-label={labels.menu} className="flex-1 overflow-y-auto px-3 py-3">
        {groups.map((g) => (
          <div key={g.key} className="mb-3">
            {compact ? <div className="mx-2 my-2 border-t border-white/10" aria-hidden /> : <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ivory/45">{g.label}</p>}
            <ul className="space-y-0.5">
              {g.items.map((item) => {
                const Icon = ICONS[item.key];
                const active = isActive(item);
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      title={compact ? item.label : undefined}
                      className={`group relative flex items-center gap-3 rounded-lg py-2 text-sm transition-colors ${compact ? "justify-center px-2" : "px-3"} ${
                        active ? "bg-white/12 font-medium text-white" : "text-ivory/75 hover:bg-white/8 hover:text-ivory"
                      }`}
                    >
                      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-1 rounded-full bg-terracotta" /> : null}
                      <Icon className={`size-[18px] shrink-0 ${active ? "text-white" : "text-ivory/70 group-hover:text-ivory"}`} aria-hidden />
                      {compact ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-white/10 p-3">
        <div className={`flex items-center gap-3 ${compact ? "justify-center" : "px-1"}`} title={compact ? `${user.name} · ${user.role}` : undefined}>
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-white/12 text-sm font-semibold text-ivory">
            {initials(user.name)}
          </span>
          {compact ? null : (
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-medium text-ivory">{user.name}</span>
              <span className="block truncate text-xs text-ivory/60">{user.role}</span>
            </span>
          )}
        </div>
        <div className={`mt-3 flex gap-1 ${compact ? "flex-col items-center" : ""}`}>
          <Link href={`${base}/security`} title={labels.security} className="flex flex-1 items-center justify-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ivory/75 hover:bg-white/8 hover:text-ivory">
            <KeyRound className="size-4" aria-hidden />
            {compact ? <span className="sr-only">{labels.security}</span> : <span className="truncate">{labels.security}</span>}
          </Link>
          {/* A full load, so the page is rendered again in the other language. */}
          <a href={otherLangHref} hrefLang={otherLang} title={labels.language} className="flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs text-ivory/75 hover:bg-white/8 hover:text-ivory">
            <Languages className="size-4" aria-hidden />
            <span className={compact ? "sr-only" : "uppercase"}>{compact ? labels.language : otherLang}</span>
          </a>
          <button type="button" onClick={signOut} disabled={signingOut} title={labels.signOut} className="flex items-center justify-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ivory/75 hover:bg-white/8 hover:text-ivory disabled:opacity-60">
            <LogOut className="size-4" aria-hidden />
            <span className="sr-only">{labels.signOut}</span>
          </button>
        </div>
        {onPhone ? null : (
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? labels.expand : labels.collapse}
            title={collapsed ? labels.expand : labels.collapse}
            className={`mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ivory/60 hover:bg-white/8 hover:text-ivory ${compact ? "justify-center" : ""}`}
          >
            {collapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
            {compact ? null : <span>{labels.collapse}</span>}
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Phones and tablets: a top bar with the menu button. */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 bg-lagoon-deep px-4 text-ivory lg:hidden">
        <button type="button" onClick={() => setMobileOpen(true)} className="-ml-2 rounded-lg p-2 hover:bg-white/10" aria-label={labels.openMenu} aria-expanded={mobileOpen}>
          <Menu className="size-5" aria-hidden />
        </button>
        <Link href={base} className="font-display text-base">
          {labels.brand} <span className="text-sm text-ivory/60">· {labels.title}</span>
        </Link>
      </header>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={labels.menu}>
          <button type="button" className="absolute inset-0 bg-ink/50" aria-label={labels.closeMenu} onClick={() => setMobileOpen(false)} />
          <aside className="relative flex h-full w-72 max-w-[85vw] flex-col bg-lagoon-deep shadow-2xl">{body(false, true)}</aside>
        </div>
      ) : null}

      {/* Wide screens: the sidebar, open or collapsed to icons. */}
      <aside className={`sticky top-0 hidden h-dvh shrink-0 flex-col bg-lagoon-deep transition-[width] duration-200 lg:flex ${collapsed ? "w-[76px]" : "w-64"}`}>{body(collapsed, false)}</aside>
    </>
  );
}
