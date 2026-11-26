/**
 * Role-based access control, checked on the server for every action.
 * Hiding a menu item is never the security boundary; this is.
 *
 * Defaults follow the reference demo (see docs/01-ANALISIS-DEMO-SAVARA.md, section 2):
 * directors see everything but change nothing, branch managers run one or
 * more properties fully, front office runs the day without cancellations,
 * reports or team pages, and housekeeping only updates villa readiness.
 */

export const roles = ["director", "branch_manager", "front_office", "housekeeping"] as const;
export type Role = (typeof roles)[number];

export const actions = [
  "dashboard.view",
  "arrivals.view",
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
  "portfolio.view",
  "team.view",
  "settings.view",
  "channels.manage",
  "rates.manage",
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
  "arrivals.view": R.operators,
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
  "villa_status.view": ["branch_manager", "front_office", "housekeeping"],
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
  "portfolio.view": ["director"],
  "team.view": ["director", "branch_manager"],
  "settings.view": R.all,
  /** Connect villas to Airbnb/Booking.com calendars (iCal); see domain/ical.ts. */
  "channels.manage": R.managers,
  /** Rates, seasons, closed-to-arrival dates, rate plans, automatic discounts and promo codes (domain/rates.ts). */
  "rates.manage": R.managers,
  /** Villa owners and monthly owner statements (domain/owners.ts). */
  "owners.view": ["director", "branch_manager"],
  /** Owners, villa ownership, commission rates, recurring costs; lock statements and record payouts. */
  "owners.manage": R.managers,
  /** Record costs charged to owners (also a maintenance ticket's cost). */
  "owners.expense": R.operators,
  /** Housekeeping, maintenance and guest-request tasks (domain/tasks.ts). */
  "tasks.view": ["branch_manager", "front_office", "housekeeping"],
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
  if (!matrix[action].includes(actor.role)) return { allowed: false, reason: "role_not_permitted" };
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

/** Roles allowed to perform an action; used to explain disabled buttons. */
export function rolesFor(action: Action): readonly Role[] {
  return matrix[action];
}
