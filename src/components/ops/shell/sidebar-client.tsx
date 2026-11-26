"use client";

import {
  BedDouble,
  Cable,
  CalendarCheck2,
  CalendarRange,
  ChartColumn,
  ChevronsUpDown,
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
  accountMenu: string;
  /** "Language" / "Bahasa"; `language` is the other language's own name. */
  languageTitle: string;
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
  // The account menu, like the phone menu, closes when the page changes.
  const [accountOn, setAccountOn] = useState<string | null>(null);
  const accountOpen = accountOn === pathname;
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

  // Escape or a click elsewhere closes the account menu.
  useEffect(() => {
    if (!accountOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAccountOn(null);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-account-menu]")) setAccountOn(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [accountOpen]);

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
        {/* Account security, language and sign-out live in a small menu on the user's name. */}
        <div data-account-menu className="relative">
          <button
            type="button"
            onClick={() => setAccountOn(accountOpen ? null : pathname)}
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            title={compact ? `${user.name} · ${user.role}` : labels.accountMenu}
            className={`flex w-full items-center gap-3 rounded-lg py-1.5 text-left hover:bg-white/8 ${compact ? "justify-center px-1" : "px-1.5"} ${accountOpen ? "bg-white/8" : ""}`}
          >
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-white/12 text-sm font-semibold text-ivory">
              {initials(user.name)}
            </span>
            {compact ? (
              <span className="sr-only">{labels.accountMenu}</span>
            ) : (
              <>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium text-ivory">{user.name}</span>
                  <span className="block truncate text-xs text-ivory/60">{user.role}</span>
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-ivory/50" aria-hidden />
              </>
            )}
          </button>
          {accountOpen ? (
            <div
              role="menu"
              aria-label={labels.accountMenu}
              className={`absolute z-50 w-60 rounded-xl border border-line bg-white p-1.5 text-ink shadow-2xl ${compact ? "bottom-0 left-full ml-3" : "bottom-full left-0 mb-2"}`}
            >
              <div className="border-b border-line/70 px-3 pb-2 pt-1.5">
                <p className="truncate text-sm font-medium">{user.name}</p>
                <p className="truncate text-xs text-stone">{user.role}</p>
              </div>
              <Link role="menuitem" href={`${base}/security`} className="mt-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-sand/60">
                <KeyRound className="size-4 text-stone" aria-hidden />
                {labels.security}
              </Link>
              {/* A full load, so the page is rendered again in the other language. */}
              <a role="menuitem" href={otherLangHref} hrefLang={otherLang} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-sand/60">
                <Languages className="size-4 text-stone" aria-hidden />
                <span className="flex-1">{labels.languageTitle}</span>
                <span className="whitespace-nowrap text-xs text-stone">{labels.language}</span>
              </a>
              <div className="my-1 border-t border-line/70" aria-hidden />
              <button role="menuitem" type="button" onClick={signOut} disabled={signingOut} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger/5 disabled:opacity-60">
                <LogOut className="size-4" aria-hidden />
                {labels.signOut}
              </button>
            </div>
          ) : null}
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
