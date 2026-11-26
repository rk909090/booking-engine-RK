import type { Action } from "./permissions";

/** How the roles screen groups the permissions. Every action appears exactly once (see permissions.test.ts). */
export const ACTION_GROUPS: Array<{ key: "home" | "reservations" | "money" | "guests" | "operations" | "business" | "admin"; actions: Action[] }> = [
  { key: "home", actions: ["dashboard.view", "calendar.view"] },
  {
    key: "reservations",
    actions: [
      "reservation.view",
      "reservation.create",
      "reservation.modify",
      "reservation.move",
      "reservation.discount",
      "reservation.guarantee",
      "reservation.check_in",
      "reservation.check_out",
      "reservation.no_show",
      "reservation.cancel",
    ],
  },
  { key: "money", actions: ["payment.record", "payment.refund", "folio.charge", "addon.manage"] },
  { key: "guests", actions: ["guest.view", "guest.edit", "guest.merge", "guest.privacy", "guest.apoa"] },
  { key: "operations", actions: ["villa_status.view", "housekeeping.update", "unit.block", "tasks.view", "tasks.work", "tasks.assign", "tasks.configure"] },
  { key: "business", actions: ["performance.view", "reports.schedule", "rates.view", "rates.manage", "channels.manage", "owners.view", "owners.manage", "owners.expense"] },
  { key: "admin", actions: ["team.view", "users.manage", "roles.manage", "settings.view", "settings.manage"] },
];
