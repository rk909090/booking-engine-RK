import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold } from "@/domain/booking";
import { createUnit, createUnitType, normaliseCancellationTiers, setUnitActive, updatePropertyContent, updatePropertyPolicies, updateUnitTypeDetails, type PolicyInput } from "@/domain/settings";
import { createTestDb, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
let ubud: typeof schema.properties.$inferSelect;
const actor = { type: "staff" as const, id: "bm-1" };

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  [ubud] = await db.select().from(schema.properties).where(eq(schema.properties.slug, "ubud"));
});
afterAll(async () => close());

const policies = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  propertyId: ubud.id,
  name: "Ubud",
  checkInTime: "14:00",
  checkOutTime: "11:00",
  taxRateBp: 1000,
  serviceRateBp: 1100,
  depositRateBp: 3000,
  balanceDueDays: 14,
  holdMinutes: 20,
  turnoverMinutes: 120,
  discountLimitFrontOfficeBp: 1000,
  discountLimitManagerBp: 5000,
  guestLateCheckoutLatest: "18:00",
  guestEarlyCheckinEarliest: "10:00",
  cancellationTiers: [
    { minDaysBefore: 0, chargeBp: 10000 },
    { minDaysBefore: 30, chargeBp: 0 },
    { minDaysBefore: 7, chargeBp: 5000 },
  ],
  actor,
  ...over,
});

describe("property policies", () => {
  it("saves times, money rules and the cancellation policy, and logs the previous values", async () => {
    expect(await updatePropertyPolicies(db, policies())).toEqual({ ok: true });
    const [p] = await db.select().from(schema.properties).where(eq(schema.properties.id, ubud.id));
    expect(p.taxRateBp).toBe(1000);
    expect(p.holdMinutes).toBe(20);
    expect(p.cancellationTiers.map((t) => t.minDaysBefore)).toEqual([30, 7, 0]);
    const [log] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "settings.policies_updated"));
    expect((log.before as { taxRateBp: number }).taxRateBp).toBe(ubud.taxRateBp);
  });

  it("refuses times that do not leave room between guests", async () => {
    expect(await updatePropertyPolicies(db, policies({ checkOutTime: "15:00" }))).toEqual({ ok: false, error: "times" });
    expect(await updatePropertyPolicies(db, policies({ guestLateCheckoutLatest: "10:00" }))).toEqual({ ok: false, error: "times" });
    expect(await updatePropertyPolicies(db, policies({ guestEarlyCheckinEarliest: "15:00" }))).toEqual({ ok: false, error: "times" });
    expect(await updatePropertyPolicies(db, policies({ checkInTime: "25:00" }))).toEqual({ ok: false, error: "times" });
  });

  it("refuses out-of-range numbers and a policy that gets cheaper closer to arrival", async () => {
    expect(await updatePropertyPolicies(db, policies({ holdMinutes: 2 }))).toEqual({ ok: false, error: "invalid" });
    expect(await updatePropertyPolicies(db, policies({ taxRateBp: 10_001 }))).toEqual({ ok: false, error: "invalid" });
    expect(normaliseCancellationTiers([{ minDaysBefore: 7, chargeBp: 5000 }, { minDaysBefore: 0, chargeBp: 2000 }])).toBeNull();
    expect(normaliseCancellationTiers([{ minDaysBefore: 7, chargeBp: 0 }, { minDaysBefore: 7, chargeBp: 5000 }])).toBeNull();
    expect(normaliseCancellationTiers([])).toBeNull();
  });
});

describe("content", () => {
  it("keeps both languages, drops empty lines and clears what was emptied", async () => {
    expect(
      await updatePropertyContent(db, {
        propertyId: ubud.id,
        tagline: { id: "Vila tepi sungai", en: "Riverside villas" },
        houseRules: { id: ["Tidak merokok di dalam", " ", "Jam tenang 22:00"], en: ["No smoking indoors"] },
        invoice: { legalName: "PT Contoh Vila", taxId: "01.234.567.8-901.000", email: "billing@example.com" },
        actor,
      }),
    ).toEqual({ ok: true });
    let [p] = await db.select().from(schema.properties).where(eq(schema.properties.id, ubud.id));
    expect(p.content.houseRules).toEqual({ id: ["Tidak merokok di dalam", "Jam tenang 22:00"], en: ["No smoking indoors"] });
    expect(p.content.invoice?.legalName).toBe("PT Contoh Vila");
    expect(await updatePropertyContent(db, { propertyId: ubud.id, invoice: { email: "not-an-email" }, actor })).toEqual({ ok: false, error: "invalid" });
    expect(await updatePropertyContent(db, { propertyId: ubud.id, actor })).toEqual({ ok: true });
    [p] = await db.select().from(schema.properties).where(eq(schema.properties.id, ubud.id));
    expect(p.content.houseRules).toBeUndefined();
    expect(p.content.tagline).toBeUndefined();
  });
});

describe("villa types and villas", () => {
  it("edits a type, its checklist and whether it is offered", async () => {
    const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
    expect(await updateUnitTypeDetails(db, { unitTypeId: type.id, name: "River Pavilion Suite", bedrooms: 1, maxGuests: 3, isPublished: false, checklist: ["Kolam bersih", "", "Handuk baru"], actor })).toEqual({ ok: true });
    const [t] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.id, type.id));
    expect([t.name, t.maxGuests, t.isPublished]).toEqual(["River Pavilion Suite", 3, false]);
    expect(t.content.inspectionChecklist).toEqual(["Kolam bersih", "Handuk baru"]);
    expect(await updateUnitTypeDetails(db, { unitTypeId: type.id, name: "X", bedrooms: 1, maxGuests: 3, isPublished: true, checklist: [], actor })).toEqual({ ok: false, error: "invalid" });
  });

  it("creates an unpublished type with a unique slug, then villas with unique codes", async () => {
    const a = await createUnitType(db, { propertyId: ubud.id, name: "Jungle Loft", bedrooms: 2, maxGuests: 4, baseRate: 7_000_000, actor });
    const b = await createUnitType(db, { propertyId: ubud.id, name: "Jungle Loft", bedrooms: 2, maxGuests: 4, baseRate: 7_000_000, actor });
    expect(a.ok && b.ok).toBe(true);
    const types = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.propertyId, ubud.id));
    expect(types.filter((t) => t.slug.startsWith("jungle-loft")).map((t) => t.slug).sort()).toEqual(["jungle-loft", "jungle-loft-2"]);
    expect(types.find((t) => t.slug === "jungle-loft")?.isPublished).toBe(false);
    const typeId = (a as { id: string }).id;
    expect((await createUnit(db, { unitTypeId: typeId, code: "ubd-jl-01", name: "", actor })).ok).toBe(true);
    expect(await createUnit(db, { unitTypeId: typeId, code: "UBD-JL-01", name: "", actor })).toEqual({ ok: false, error: "code_taken" });
    expect(await createUnit(db, { unitTypeId: typeId, code: "bad code!", name: "", actor })).toEqual({ ok: false, error: "invalid" });
  });

  it("does not take a villa with a coming booking out of use", async () => {
    const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "canopy-villa"));
    const [unit] = await db.select().from(schema.units).where(eq(schema.units.unitTypeId, type.id)).orderBy(schema.units.code);
    const hold = await createHold(db, { unitTypeId: type.id, checkIn: "2027-03-10", checkOut: "2027-03-13", adults: 2, children: 0, guest: { fullName: "G", email: "g@example.com" }, locale: "en", source: "website", now: new Date("2027-01-02T03:00:00Z"), candidateUnitIds: [unit.id] });
    expect(hold.ok).toBe(true);
    expect(await setUnitActive(db, { unitId: unit.id, active: false, today: "2027-01-02", actor })).toEqual({ ok: false, error: "has_bookings" });
    // After the stay it can go.
    expect(await setUnitActive(db, { unitId: unit.id, active: false, today: "2027-03-13", actor })).toEqual({ ok: true });
    expect(await setUnitActive(db, { unitId: unit.id, active: true, today: "2027-03-13", actor })).toEqual({ ok: true });
  });
});
