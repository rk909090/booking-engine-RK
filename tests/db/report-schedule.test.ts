import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { addSubscription, duePeriods, finishRun, pendingRuns, queueDueReports, recipientsFor, reportPeriod } from "@/domain/report-schedule";
import { createTestDb, type TestDb } from "./test-db";

const manager = { type: "staff" as const, id: "bm-1" };
let db: TestDb;
let close: () => Promise<void>;
let propertyId: string;
let bm: string;
let fo: string;
let director: string;

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const [ubud] = await db.select().from(schema.properties).where(eq(schema.properties.slug, "ubud"));
  propertyId = ubud.id;
  const staff = await db
    .insert(schema.staffMembers)
    .values([
      { email: "bm@example.com", fullName: "Branch", role: "branch_manager" },
      { email: "fo@example.com", fullName: "Front", role: "front_office" },
      { email: "dir@example.com", fullName: "Director", role: "director" },
    ])
    .returning();
  [bm, fo, director] = staff.map((s) => s.id);
  await db.insert(schema.staffPropertyAccess).values([{ staffId: bm, propertyId }, { staffId: fo, propertyId }]);
});
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(schema.reportRuns);
  await db.delete(schema.reportSubscriptions);
});

describe("when reports are due", () => {
  it("sends daily from 07:00, weekly on Mondays, monthly on the 1st, each covering the right period", () => {
    expect(duePeriods("2026-11-30T06:59")).toEqual([]);
    // 30 Nov 2026 is a Monday.
    expect(duePeriods("2026-11-30T07:00").map((p) => [p.kind, p.periodKey, p.from, p.to])).toEqual([
      ["daily", "2026-11-30", "2026-11-29", "2026-11-29"],
      ["weekly", "2026-11-30", "2026-11-23", "2026-11-29"],
    ]);
    expect(duePeriods("2026-12-01T09:15").map((p) => [p.kind, p.periodKey, p.from, p.to])).toEqual([
      ["daily", "2026-12-01", "2026-11-30", "2026-11-30"],
      ["monthly", "2026-11", "2026-11-01", "2026-11-30"],
    ]);
    expect(reportPeriod("monthly", "2027-01-01")).toMatchObject({ periodKey: "2026-12", from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("recipients and runs", () => {
  it("accepts directors, the property's branch managers and other addresses once each", async () => {
    expect(await addSubscription(db, { propertyId, kind: "daily", staffId: bm, actor: manager })).toEqual({ ok: true });
    expect(await addSubscription(db, { propertyId, kind: "daily", staffId: director, locale: "en", actor: manager })).toEqual({ ok: true });
    expect(await addSubscription(db, { propertyId, kind: "daily", staffId: fo, actor: manager })).toEqual({ ok: false, error: "not_eligible" });
    expect(await addSubscription(db, { propertyId, kind: "daily", email: "Accountant@Example.com", actor: manager })).toEqual({ ok: true });
    expect(await addSubscription(db, { propertyId, kind: "daily", email: "accountant@example.com", actor: manager })).toEqual({ ok: false, error: "duplicate" });
    expect(await addSubscription(db, { propertyId, kind: "daily", email: "not-an-email", actor: manager })).toEqual({ ok: false, error: "invalid" });
    expect(await addSubscription(db, { propertyId, kind: "hourly", email: "a@example.com", actor: manager })).toEqual({ ok: false, error: "invalid" });
    expect((await recipientsFor(db, propertyId, "daily")).sort((a, b) => a.email.localeCompare(b.email))).toEqual([
      { email: "accountant@example.com", locale: "id" },
      { email: "bm@example.com", locale: "id" },
      { email: "dir@example.com", locale: "en" },
    ]);
    await db.update(schema.staffMembers).set({ isActive: false }).where(eq(schema.staffMembers.id, director));
    expect((await recipientsFor(db, propertyId, "daily")).map((r) => r.email)).not.toContain("dir@example.com");
    await db.update(schema.staffMembers).set({ isActive: true }).where(eq(schema.staffMembers.id, director));
  });

  it("queues each due report once, retries failures, and skips what could not go out in time", async () => {
    await addSubscription(db, { propertyId, kind: "daily", staffId: bm, actor: manager });
    await addSubscription(db, { propertyId, kind: "monthly", staffId: bm, actor: manager });
    // 1 Dec 2026, 08:00 in Bali (00:00 UTC).
    const now = new Date("2026-12-01T00:00:00Z");
    expect(await queueDueReports(db, now)).toBe(2);
    expect(await queueDueReports(db, new Date("2026-12-01T05:00:00Z"))).toBe(0);
    const runs = await pendingRuns(db, now);
    expect(runs.map((r) => [r.run.kind, r.run.periodKey]).sort()).toEqual([["daily", "2026-12-01"], ["monthly", "2026-11"]]);

    const daily = runs.find((r) => r.run.kind === "daily")!.run;
    await finishRun(db, { runId: daily.id, ok: false, recipients: 1, error: "resend 500", now });
    expect((await db.select().from(schema.reportRuns).where(eq(schema.reportRuns.id, daily.id)))[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "resend 500" });
    await finishRun(db, { runId: daily.id, ok: true, recipients: 1, now });
    expect((await db.select().from(schema.reportRuns).where(eq(schema.reportRuns.id, daily.id)))[0]).toMatchObject({ status: "sent", recipients: 1 });

    // Four days later the monthly one is stale.
    expect(await pendingRuns(db, new Date("2026-12-05T00:00:00Z"))).toEqual([]);
    expect((await db.select().from(schema.reportRuns).where(eq(schema.reportRuns.kind, "monthly")))[0].status).toBe("skipped");
  });
});
