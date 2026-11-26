/**
 * Role-based access control, checked on the server for every action.
 * Hiding a menu item is never the security boundary; this is.
 *
 * Defaults follow the reference demo (see docs/01-ANALISIS-DEMO-SAVARA.md, section 2):
 * directors see everything and administer users, roles and settings (but do
 * not run bookings), branch managers run one or more properties fully, front
 * office runs the day without cancellations, reports or team pages, and
 * housekeeping only updates villa readiness.
 *
 * The matrix below holds the defaults. A director can change them per role on
 * the roles screen (saved as overrides in role_permissions); the cells in
 * isLocked() never change, so nobody can lock the group out.
 */

export const roles = ["director", "branch_manager", "front_office", "housekeeping"] as const;
export type Role = (typeof roles)[number];

export const actions = [
  "dashboard.view",
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
  "payment.refund",
  "payment.record",
  "folio.charge",
  "calendar.view",
  "villa_status.view",
  "housekeeping.update",
  "unit.block",
  "addon.manage",
  "guest.view",
  "guest.edit",
  "guest.merge",
  "guest.privacy",
  "guest.apoa",
  "performance.view",
  "team.view",
  "settings.view",
  "settings.manage",
  "users.manage",
  "roles.manage",
  "channels.manage",
  "rates.view",
  "rates.manage",
  "reports.schedule",
  "owners.view",
  "owners.manage",
  "owners.expense",
  "tasks.view",
  "tasks.work",
  "tasks.assign",
  "tasks.configure",
] as const;
export type Action = (typeof actions)[number];

const R = {
  all: ["director", "branch_manager", "front_office", "housekeeping"],
  allButHousekeeping: ["director", "branch_manager", "front_office"],
  operators: ["branch_manager", "front_office"],
  managers: ["branch_manager"],
} as const satisfies Record<string, readonly Role[]>;

const matrix: Record<Action, readonly Role[]> = {
  "dashboard.view": R.all,
  "reservation.view": R.allButHousekeeping,
  "reservation.create": R.operators,
  "reservation.modify": R.operators,
  "reservation.move": R.operators,
  /** Each role's ceiling is a property setting (see domain/discount.ts). */
  "reservation.discount": R.operators,
  /** Confirm without the deposit (always with a reason; see domain/guarantee.ts). */
  "reservation.guarantee": R.operators,
  "reservation.check_in": R.operators,
  "reservation.check_out": R.operators,
  "reservation.no_show": R.operators,
  "reservation.cancel": R.managers,
  "payment.refund": R.managers,
  "payment.record": R.operators,
  /** Add or void folio charges, add paying parties, issue invoices (domain/folio.ts). */
  "folio.charge": R.operators,
  "calendar.view": R.allButHousekeeping,
  "villa_status.view": R.all,
  "housekeeping.update": ["branch_manager", "front_office", "housekeeping"],
  "unit.block": R.operators,
  "guest.view": R.allButHousekeeping,
  /** Confirm, decline, cancel or add add-on orders on a booking (domain/addons.ts). */
  "addon.manage": R.operators,
  /** Contact details, notes, preferences and tags of a guest profile (domain/guests.ts). */
  "guest.edit": R.operators,
  "guest.merge": R.operators,
  /** UU PDP requests: export a guest's data and erase it. */
  "guest.privacy": R.managers,
  /** Foreign guest list for immigration (APOA): export with document numbers, mark reported. */
  "guest.apoa": R.operators,
  "performance.view": ["director", "branch_manager"],
  "team.view": ["director", "branch_manager"],
  /** The settings pages (property, policies, content, villas, integrations). */
  "settings.view": ["director", "branch_manager"],
  /** Change a property's settings (branch managers: their own properties). */
  "settings.manage": ["director", "branch_manager"],
  /** Invite staff, change their role and properties, deactivate, reset 2FA. */
  "users.manage": ["director"],
  /** Change what each role may do (this matrix). */
  "roles.manage": ["director"],
  /** Connect villas to Airbnb/Booking.com calendars (iCal); see domain/ical.ts. */
  "channels.manage": R.managers,
  /** See rates, seasons, offers, add-ons and promo codes (directors read only). */
  "rates.view": ["director", "branch_manager"],
  /** Rates, seasons, closed-to-arrival dates, rate plans, automatic discounts and promo codes (domain/rates.ts). */
  "rates.manage": R.managers,
  /** Choose who receives the scheduled report emails (domain/report-schedule.ts). */
  "reports.schedule": R.managers,
  /** Villa owners and monthly owner statements (domain/owners.ts). */
  "owners.view": ["director", "branch_manager"],
  /** Owners, villa ownership, commission rates, recurring costs; lock statements and record payouts. */
  "owners.manage": R.managers,
  /** Record costs charged to owners (also a maintenance ticket's cost). */
  "owners.expense": R.operators,
  /** Housekeeping, maintenance and guest-request tasks (domain/tasks.ts). */
  "tasks.view": R.all,
  /** Claim, start and finish tasks; report maintenance. */
  "tasks.work": ["branch_manager", "front_office", "housekeeping"],
  "tasks.assign": R.operators,
  /** Edit the inspection checklists. */
  "tasks.configure": R.managers,
};

export type Actor = {
  staffId: string;
  role: Role;
  isActive: boolean;
  /** Properties this actor is assigned to. Ignored for directors, who see all. */
  propertyIds: readonly string[];
  /**
   * What this actor's role may do, with the saved overrides applied (see
   * permissionsFor). Without it the default matrix applies.
   */
  permissions?: readonly Action[];
};

export type DenyReason = "inactive" | "role_not_permitted" | "outside_property_scope";

export type Decision = { allowed: true } | { allowed: false; reason: DenyReason };

export function hasGlobalScope(actor: Actor): boolean {
  return actor.role === "director";
}

export function canAccessProperty(actor: Actor, propertyId: string): boolean {
  return hasGlobalScope(actor) || actor.propertyIds.includes(propertyId);
}

/**
 * @param propertyId the property the action targets; omit only for actions
 *   that are not tied to one property (for example the group portfolio).
 */
export function can(actor: Actor, action: Action, propertyId?: string): Decision {
  if (!actor.isActive) return { allowed: false, reason: "inactive" };
  const roleAllows = actor.permissions ? actor.permissions.includes(action) : matrix[action].includes(actor.role);
  if (!roleAllows) return { allowed: false, reason: "role_not_permitted" };
  if (propertyId !== undefined && !canAccessProperty(actor, propertyId)) {
    return { allowed: false, reason: "outside_property_scope" };
  }
  return { allowed: true };
}

export class ForbiddenError extends Error {
  constructor(
    readonly action: Action,
    readonly reason: DenyReason,
  ) {
    super(`Forbidden: ${action} (${reason})`);
    this.name = "ForbiddenError";
  }
}

/** Throws ForbiddenError when the actor may not perform the action. */
export function authorize(actor: Actor, action: Action, propertyId?: string): void {
  const decision = can(actor, action, propertyId);
  if (!decision.allowed) throw new ForbiddenError(action, decision.reason);
}

/** Roles allowed to perform an action by default (before overrides). */
export function rolesFor(action: Action): readonly Role[] {
  return matrix[action];
}

/** Whether a role may perform an action by default (before overrides). */
export function defaultAllows(role: Role, action: Action): boolean {
  return matrix[action].includes(role);
}

/**
 * Cells of the matrix that cannot be changed: only directors manage users and
 * roles, everybody has a home page, and directors always keep the team and
 * settings pages. Otherwise a single save could lock everyone out.
 */
export function isLocked(role: Role, action: Action): boolean {
  if (action === "users.manage" || action === "roles.manage" || action === "dashboard.view") return true;
  return role === "director" && (action === "team.view" || action === "settings.view" || action === "settings.manage");
}

export type PermissionOverride = { role: string; action: string; allowed: boolean };

/** What a role may do: the defaults, changed by the saved overrides (locked cells keep their default). */
export function permissionsFor(role: Role, overrides: readonly PermissionOverride[]): Action[] {
  return actions.filter((action) => {
    if (isLocked(role, action)) return defaultAllows(role, action);
    const saved = overrides.find((o) => o.role === role && o.action === action);
    return saved ? saved.allowed : defaultAllows(role, action);
  });
}
