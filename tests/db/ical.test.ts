import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { availabilityCalendar, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { buildIcs, calendarConflicts, exportEvents, exportToken, parseIcs, syncDueFeeds, syncFeed, validFeedUrl } from "@/domain/ical";
import { previewStayChange } from "@/domain/modify";
import { createTestDb, type TestDb } from "./test-db";

const at = (date: string, utc = "03:00") => new Date(`${date}T${utc}:00Z`);
const now = at("2027-01-05");

// Shapes as published by Airbnb and Booking.com (all-day DATE values), with a folded line.
const AIRBNB = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Airbnb Inc//Hosting Calendar 0.8.8//EN",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTEND;VALUE=DATE:20270212",
  "DTSTART;VALUE=DATE:20270210",
  "UID:1418fb94e984-0f0a4dd41c1cd5f22d0b9bc3e3f8a5a6@airbnb.com",
  "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABC123\\nPhone Number (L",
  " ast 4 Digits): 1234",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTEND;VALUE=DATE:20270302",
  "DTSTART;VALUE=DATE:20270228",
  "UID:7f3c2d1e-airbnb-blocked@airbnb.com",
  "SUMMARY:Airbnb (Not available)",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const BOOKING = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Booking.com//NONSGML//EN",
  "BEGIN:VEVENT",
  "UID:ab12cd34@booking.com",
  "DTSTART;VALUE=DATE:20270211",
  "DTEND;VALUE=DATE:20270213",
  "SUMMARY:CLOSED - Not available",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

describe("reading and writing iCal", () => {
  it("reads all-day events from Airbnb and Booking.com, unfolding long lines", () => {
    expect(parseIcs(AIRBNB, "Asia/Makassar")).toEqual([
      { uid: "1418fb94e984-0f0a4dd41c1cd5f22d0b9bc3e3f8a5a6@airbnb.com", startDate: "2027-02-10", endDate: "2027-02-12", summary: "Reserved" },
      { uid: "7f3c2d1e-airbnb-blocked@airbnb.com", startDate: "2027-02-28", endDate: "2027-03-02", summary: "Airbnb (Not available)" },
    ]);
    expect(parseIcs(BOOKING, "Asia/Makassar")).toEqual([{ uid: "ab12cd34@booking.com", startDate: "2027-02-11", endDate: "2027-02-13", summary: "CLOSED - Not available" }]);
  });

  it("takes UTC times as dates in Bali, fills a missing end, skips cancelled events, and survives a missing UID", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT", "UID:a", "DTSTART:20270209T170000Z", "DTEND:20270211T020000Z", "END:VEVENT", // 01:00 on the 10th in Bali
      "BEGIN:VEVENT", "UID:b", "DTSTART;VALUE=DATE:20270301", "END:VEVENT",
      "BEGIN:VEVENT", "UID:c", "DTSTART;VALUE=DATE:20270305", "DTEND;VALUE=DATE:20270307", "STATUS:CANCELLED", "END:VEVENT",
      "BEGIN:VEVENT", "DTSTART;TZID=Asia/Makassar:20270320T140000", "DTEND;TZID=Asia/Makassar:20270322T110000", "SUMMARY:No uid", "END:VEVENT",
      "BEGIN:VEVENT", "UID:bad", "DTSTART:garbage", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    expect(parseIcs(ics, "Asia/Makassar")).toEqual([
      { uid: "a", startDate: "2027-02-10", endDate: "2027-02-11", summary: null },
      { uid: "b", startDate: "2027-03-01", endDate: "2027-03-02", summary: null },
      { uid: "2027-03-20/2027-03-22/No uid", startDate: "2027-03-20", endDate: "2027-03-22", summary: "No uid" },
    ]);
  });

  it("writes a calendar with only dates and a neutral label, lines folded at 75 octets", () => {
    const ics = buildIcs({ calendarName: "Attara UBD-RVP-01", label: "Not available", events: [{ uid: `booking-${"x".repeat(90)}@attara`, startDate: "2027-02-10", endDate: "2027-02-12" }], now });
    expect(ics).toContain("DTSTART;VALUE=DATE:20270210\r\nDTEND;VALUE=DATE:20270212\r\nSUMMARY:Not available");
    expect(ics.split("\r\n").every((line) => line.length <= 75)).toBe(true);
    expect(parseIcs(ics, "Asia/Makassar")).toEqual([{ uid: `booking-${"x".repeat(90)}@attara`, startDate: "2027-02-10", endDate: "2027-02-12", summary: "Not available" }]);
  });

  it("accepts only https channel addresses, not local or IP addresses", () => {
    expect(validFeedUrl("https://www.airbnb.com/calendar/ical/123.ics?s=abc")?.host).toBe("www.airbnb.com");
    expect(validFeedUrl("http://www.airbnb.com/calendar/ical/123.ics")).toBeNull();
    expect(validFeedUrl("https://localhost/x.ics")).toBeNull();
    expect(validFeedUrl("https://169.254.169.254/latest")).toBeNull();
    expect(validFeedUrl("https://user:pw@example.com/x.ics")).toBeNull();
    expect(validFeedUrl("not a url")).toBeNull();
  });
});

describe("sync with the database", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let typeId: string;
  let unitIds: string[];

  beforeAll(async () => {
    const test = await createTestDb();
    db = test.db;
    close = () => test.client.close();
    await seedSampleData(db);
    const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
    typeId = type.id;
    unitIds = (await db.select().from(schema.units).where(eq(schema.units.unitTypeId, typeId)).orderBy(schema.units.code)).map((u) => u.id);
  });
  afterAll(async () => close());
  beforeEach(async () => {
    for (const table of [schema.icalEvents, schema.icalFeeds, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) await db.delete(table);
  });

  async function feed(unit: number, name: string, url = `https://example.com/${name}.ics`) {
    const [f] = await db.insert(schema.icalFeeds).values({ unitId: unitIds[unit], name, url }).returning();
    return f;
  }
  const serve = (text: string) => async () => text;

  it("imports a channel calendar, follows its changes, and keeps the old events when the channel cannot be read", async () => {
    const f = await feed(0, "Airbnb");
    expect(await syncFeed(db, f.id, serve(AIRBNB), now)).toEqual({ ok: true, events: 2 });
    let events = await db.select().from(schema.icalEvents).orderBy(schema.icalEvents.startDate);
    expect(events.map((e) => [e.startDate, e.endDate])).toEqual([["2027-02-10", "2027-02-12"], ["2027-02-28", "2027-03-02"]]);

    // The stay was shortened and the block removed on Airbnb.
    const changed = AIRBNB.replace("DTEND;VALUE=DATE:20270212", "DTEND;VALUE=DATE:20270211").replace(/BEGIN:VEVENT\r\nDTEND;VALUE=DATE:20270302[\s\S]*?END:VEVENT\r\n/, "");
    expect(await syncFeed(db, f.id, serve(changed), now)).toEqual({ ok: true, events: 1 });
    events = await db.select().from(schema.icalEvents);
    expect(events.map((e) => [e.startDate, e.endDate])).toEqual([["2027-02-10", "2027-02-11"]]);

    expect(await syncFeed(db, f.id, async () => { throw new Error("HTTP 404"); }, now)).toEqual({ ok: false, error: "HTTP 404" });
    expect(await db.select().from(schema.icalEvents)).toHaveLength(1);
    const [after] = await db.select().from(schema.icalFeeds).where(eq(schema.icalFeeds.id, f.id));
    expect(after).toMatchObject({ lastStatus: "error", lastError: "HTTP 404", eventCount: 1 });
  });

  it("blocks imported nights for new bookings, the availability calendar and date changes", async () => {
    const f = await feed(0, "Airbnb");
    await syncFeed(db, f.id, serve(AIRBNB), now);
    const hold = (unit: number, checkIn = "2027-02-10", checkOut = "2027-02-12") =>
      createHold(db, { unitTypeId: typeId, checkIn, checkOut, adults: 2, children: 0, guest: { fullName: "G", email: "g@example.com" }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[unit]] });
    expect(await hold(0)).toMatchObject({ ok: false, error: { kind: "sold_out" } });
    const cal = await availabilityCalendar(db, { unitTypeId: typeId, from: "2027-02-09", days: 3, now });
    expect(cal).toEqual([{ date: "2027-02-09", free: 3 }, { date: "2027-02-10", free: 2 }, { date: "2027-02-11", free: 2 }]);

    const other = await hold(1, "2027-02-05", "2027-02-07");
    if (!other.ok) throw new Error();
    await createPendingPayment(db, { reservationId: other.reservation.id, provider: "simulated", providerRef: "p1", purpose: "full", amount: other.reservation.totalAmount, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: "p1", amount: other.reservation.totalAmount, paidAt: now });
    const preview = await previewStayChange(db, { reservationId: other.reservation.id, checkIn: "2027-02-10", checkOut: "2027-02-12", unitId: unitIds[0], now });
    expect(preview).toMatchObject({ ok: false, error: "channel_booked" });
  });

  it("exports bookings, maintenance and other channels' stays under one stable secret token", async () => {
    const token = await exportToken(db, unitIds[0]);
    expect(await exportToken(db, unitIds[0])).toBe(token);
    const f = await feed(0, "Booking.com");
    await syncFeed(db, f.id, serve(BOOKING), now);
    const h = await createHold(db, { unitTypeId: typeId, checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, guest: { fullName: "Secret Name", email: "s@example.com" }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[0]] });
    if (!h.ok) throw new Error();
    const found = await exportEvents(db, token, now);
    expect(found?.events.map((e) => [e.startDate, e.endDate])).toEqual([["2027-02-01", "2027-02-03"], ["2027-02-11", "2027-02-13"]]);
    expect(await exportEvents(db, "wrong-token-wrong-token", now)).toBeNull();
  });

  it("lists conflicts with our bookings and between channels, and re-reads feeds only when due", async () => {
    const airbnb = await feed(0, "Airbnb");
    const booking = await feed(0, "Booking.com");
    const h = await createHold(db, { unitTypeId: typeId, checkIn: "2027-02-28", checkOut: "2027-03-01", adults: 2, children: 0, guest: { fullName: "G", email: "g@example.com" }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[0]] });
    if (!h.ok) throw new Error();
    await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: "p2", purpose: "full", amount: h.reservation.totalAmount, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: "p2", amount: h.reservation.totalAmount, paidAt: now });

    const texts: Record<string, string> = { [airbnb.url]: AIRBNB, [booking.url]: BOOKING };
    expect(await syncDueFeeds(db, async (url) => texts[url], now)).toEqual({ ok: 2, failed: 0 });
    expect(await syncDueFeeds(db, async (url) => texts[url], new Date(now.getTime() + 5 * 60_000))).toEqual({ ok: 0, failed: 0 });

    const [property] = await db.select({ id: schema.unitTypes.propertyId }).from(schema.unitTypes).where(eq(schema.unitTypes.id, typeId));
    const conflicts = await calendarConflicts(db, { propertyIds: [property.id], today: "2027-01-05", now });
    expect(conflicts.map((c) => [c.feedName, c.startDate, c.codes, c.otherFeeds])).toEqual([
      ["Airbnb", "2027-02-10", [], ["Booking.com"]],
      ["Booking.com", "2027-02-11", [], ["Airbnb"]],
      ["Airbnb", "2027-02-28", [h.reservation.code], []],
    ]);
  });
});
