import { describe, expect, it } from "vitest";
import { actions, authorize, can, ForbiddenError, rolesFor, type Actor, type Role } from "./permissions";

const UBUD = "prop-ubud";
const CANGGU = "prop-canggu";

function actor(role: Role, overrides: Partial<Actor> = {}): Actor {
  return { staffId: "s1", role, isActive: true, propertyIds: [UBUD], ...overrides };
}

describe("permissions matrix", () => {
  it("defines at least one role for every action", () => {
    for (const action of actions) expect(rolesFor(action).length).toBeGreaterThan(0);
  });

  it("keeps directors read-only", () => {
    const director = actor("director", { propertyIds: [] });
    const mutations = actions.filter(
      (a) => a.startsWith("reservation.") && a !== "reservation.view",
    );
    for (const action of mutations) {
      expect(can(director, action, UBUD)).toEqual({ allowed: false, reason: "role_not_permitted" });
    }
    expect(can(director, "reservation.view", CANGGU)).toEqual({ allowed: true });
    expect(can(director, "portfolio.view")).toEqual({ allowed: true });
  });

  it("lets only branch managers cancel", () => {
    expect(can(actor("branch_manager"), "reservation.cancel", UBUD).allowed).toBe(true);
    expect(can(actor("front_office"), "reservation.cancel", UBUD)).toEqual({
      allowed: false,
      reason: "role_not_permitted",
    });
  });

  it("lets only branch managers record refund payouts", () => {
    expect(can(actor("branch_manager"), "payment.refund", UBUD).allowed).toBe(true);
    expect(can(actor("front_office"), "payment.refund", UBUD).allowed).toBe(false);
    expect(can(actor("director", { propertyIds: [] }), "payment.refund", UBUD).allowed).toBe(false);
  });

  it("hides reports and team from front office", () => {
    expect(can(actor("front_office"), "performance.view", UBUD).allowed).toBe(false);
    expect(can(actor("front_office"), "team.view", UBUD).allowed).toBe(false);
  });

  it("limits housekeeping to villa readiness", () => {
    const hk = actor("housekeeping");
    expect(can(hk, "housekeeping.update", UBUD).allowed).toBe(true);
    expect(can(hk, "reservation.view", UBUD).allowed).toBe(false);
    expect(can(hk, "guest.view", UBUD).allowed).toBe(false);
  });
});

describe("property scope", () => {
  it("blocks staff from properties they are not assigned to", () => {
    expect(can(actor("branch_manager"), "reservation.view", CANGGU)).toEqual({
      allowed: false,
      reason: "outside_property_scope",
    });
  });

  it("allows staff assigned to several properties on each of them", () => {
    const fo = actor("front_office", { propertyIds: [UBUD, CANGGU] });
    expect(can(fo, "reservation.check_in", CANGGU).allowed).toBe(true);
  });
});

describe("inactive staff", () => {
  it("are denied everything, before any other check", () => {
    const off = actor("branch_manager", { isActive: false });
    for (const action of actions) {
      expect(can(off, action, UBUD)).toEqual({ allowed: false, reason: "inactive" });
    }
  });
});

describe("authorize", () => {
  it("throws a typed error with the reason", () => {
    try {
      authorize(actor("front_office"), "reservation.cancel", UBUD);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).reason).toBe("role_not_permitted");
    }
  });
});
