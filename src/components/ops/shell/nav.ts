import type { Action } from "@/lib/authz/permissions";

/*
 * The staff area's main menu, in groups. An item shows when the signed-in
 * staff member may do at least one of its actions (pages still check on the
 * server). Icons are named here and drawn by the client sidebar.
 */

export type NavIcon =
  | "home"
  | "reservations"
  | "calendar"
  | "guests"
  | "villaStatus"
  | "tasks"
  | "reports"
  | "rates"
  | "owners"
  | "channels"
  | "users"
  | "roles"
  | "settings";

/** Remembers a collapsed sidebar. Kept here, not in the client module: a server component importing a
 * constant from a "use client" file gets a client reference, not the string. */
export const SIDEBAR_COOKIE = "ops-sidebar";

export type NavKey = NavIcon;
export type NavGroupKey = "main" | "operations" | "business" | "admin";

/** `also`: other pages that belong to the item (highlighted with it). */
export const NAV: Array<{ group: NavGroupKey; items: Array<{ key: NavKey; href: string; actions: Action[]; also?: string[] }> }> = [
  {
    group: "main",
    items: [
      { key: "home", href: "", actions: ["dashboard.view"] },
      { key: "reservations", href: "/reservations", actions: ["reservation.view"], also: ["/new-booking"] },
      { key: "calendar", href: "/calendar", actions: ["calendar.view"] },
      { key: "guests", href: "/guests", actions: ["guest.view"], also: ["/immigration"] },
    ],
  },
  {
    group: "operations",
    items: [
      { key: "villaStatus", href: "/villa-status", actions: ["villa_status.view"] },
      { key: "tasks", href: "/tasks", actions: ["tasks.view"] },
    ],
  },
  {
    group: "business",
    items: [
      { key: "reports", href: "/reports", actions: ["performance.view"] },
      { key: "rates", href: "/rates", actions: ["rates.view"] },
      // Front office reach the owners area for expenses only.
      { key: "owners", href: "/owners", actions: ["owners.view", "owners.expense"] },
      { key: "channels", href: "/channels", actions: ["channels.manage"] },
    ],
  },
  {
    group: "admin",
    items: [
      { key: "users", href: "/users", actions: ["team.view"] },
      { key: "roles", href: "/roles", actions: ["roles.manage"] },
      { key: "settings", href: "/settings", actions: ["settings.view"] },
    ],
  },
];
