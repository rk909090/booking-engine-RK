import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { decideLateCheckout, requestLateCheckout } from "@/domain/late-checkout";
import { claimMessages, finishMessage, queueReminders, whatsappNumber } from "@/domain/notifications";
import { savePreCheckin } from "@/domain/pre-checkin";
import { deliverPending } from "@/lib/notifications/deliver";
import { createResendSender, createWhatsAppSender, type EmailMessage, type WhatsAppMessage } from "@/lib/notifications/providers";
import { createTestDb, type TestDb } from "./test-db";

process.env.BETTER_AUTH_SECRET ||= "test-only-secret-for-notifications";
const at = (date: string, utc = "03:00") => new Date(`${date}T${utc}:00Z`);
const staff = { type: "staff" as const, id: "fo-1" };

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
  for (const table of [schema.preCheckinGuests, schema.preCheckins, schema.lateCheckoutRequests, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

async function booking(opts: { email?: string | null; phone?: string | null; checkIn?: string; checkOut?: string; pay?: "full" | "deposit" | "none"; unit?: number } = {}) {
  const h = await createHold(db, {
    unitTypeId: typeId,
    checkIn: opts.checkIn ?? "2027-02-10",
    checkOut: opts.checkOut ?? "2027-02-12",
    adults: 2,
    children: 0,
    guest: { fullName: "Ana Smith", email: opts.email === undefined ? "ana@example.com" : opts.email, phone: opts.phone === undefined ? "0811 2345 6789" : opts.phone },
    locale: "id",
    source: "website",
    now: at("2027-01-05"),
    candidateUnitIds: [unitIds[opts.unit ?? 0]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  if (opts.pay !== "none") {
    const amount = opts.pay === "deposit" ? h.reservation.depositAmount : h.reservation.totalAmount;
    await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `r-${h.reservation.code}`, purpose: "full", amount, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: `r-${h.reservation.code}`, amount, paidAt: at("2027-01-05") });
  }
  return h.reservation;
}

const outbox = () => db.select().from(schema.notificationOutbox).orderBy(schema.notificationOutbox.createdAt, schema.notificationOutbox.channel);

describe("queueing guest messages", () => {
  it("normalises WhatsApp numbers (0… is Indonesian) and rejects what cannot be a number", () => {
    expect(whatsappNumber("0811 2345 6789")).toBe("6281123456789");
    expect(whatsappNumber("+61 412 345 678")).toBe("61412345678");
    expect(whatsappNumber("0061412345678")).toBe("61412345678");
    expect(whatsappNumber("62 811-2345-6789")).toBe("6281123456789");
    expect(whatsappNumber("+62 811")).toBeNull();
    expect(whatsappNumber("call me")).toBeNull();
    expect(whatsappNumber(null)).toBeNull();
  });

  it("queues a confirmation on email and WhatsApp when the guest gave both, and on email alone otherwise", async () => {
    const both = await booking();
    expect((await outbox()).map((m) => [m.kind, m.channel, m.recipient])).toEqual([
      ["booking_confirmed", "email", "ana@example.com"],
      ["booking_confirmed", "whatsapp", "6281123456789"],
    ]);
    await db.delete(schema.notificationOutbox);
    await booking({ phone: null, unit: 1 });
    expect((await outbox()).map((m) => m.channel)).toEqual(["email"]);
    expect(both.code).toBeTruthy();
  });

  it("tells the guest about a cancellation of a confirmed booking with the refund, not about a cancelled hold", async () => {
    const r = await booking({ pay: "deposit" });
    const hold = await booking({ pay: "none", unit: 1 });
    await db.delete(schema.notificationOutbox);
    await cancelReservation(db, { reservationId: hold.id, actor: { type: "guest" }, now: at("2027-01-06") });
    expect(await outbox()).toHaveLength(0);
    await cancelReservation(db, { reservationId: r.id, actor: { type: "guest" }, now: at("2027-01-06") });
    const [m] = await outbox();
    expect(m).toMatchObject({ kind: "booking_cancelled", payload: { refund: r.depositAmount, fee: 0 } });
  });

  it("tells the guest the late check-out decision", async () => {
    const r = await booking();
    await requestLateCheckout(db, { reservationId: r.id, time: "15:00", actor: staff, now: at("2027-01-06") });
    await decideLateCheckout(db, { reservationId: r.id, approve: true, fee: 250_000, actor: staff, now: at("2027-01-06") });
    expect((await outbox()).filter((m) => m.kind === "late_checkout_decided").map((m) => m.payload)).toEqual([
      expect.objectContaining({ approved: true, time: "15:00", fee: 250_000 }),
      expect.objectContaining({ approved: true, time: "15:00", fee: 250_000 }),
    ]);
  });

  it("queues each reminder once: pre-check-in up to 3 days before arrival if not done, payment the day before it is due", async () => {
    const r = await booking({ pay: "deposit", phone: null });
    await db.delete(schema.notificationOutbox);
    // Balance due 2027-01-27 (14 days before), arrival 2027-02-10.
    expect(await queueReminders(db, at("2027-01-20"))).toEqual({ precheckin: 0, payment: 0 });
    expect(await queueReminders(db, at("2027-01-26"))).toEqual({ precheckin: 0, payment: 1 });
    expect(await queueReminders(db, at("2027-01-26"))).toEqual({ precheckin: 0, payment: 0 });
    expect((await outbox())[0]).toMatchObject({ kind: "payment_reminder", payload: { dueDate: "2027-01-27", amount: r.totalAmount - r.depositAmount } });

    expect(await queueReminders(db, at("2027-02-06"))).toEqual({ precheckin: 0, payment: 0 });
    expect(await queueReminders(db, at("2027-02-07"))).toEqual({ precheckin: 1, payment: 0 });
    expect(await queueReminders(db, at("2027-02-08"))).toEqual({ precheckin: 0, payment: 0 });

    // A guest who already did the pre-check-in is not reminded.
    const done = await booking({ unit: 1, phone: null, checkIn: "2027-02-20", checkOut: "2027-02-22" });
    await savePreCheckin(
      db,
      {
        reservationId: done.id, arrivalTime: "", flightNumber: "", landingDate: "", landingTime: "", transferRequested: false, transferNote: "", requests: "", acceptRules: true,
        guests: [0, 1].map(() => ({ fullName: "Guest Name", nationality: "AU", birthDate: "1990-01-01", documentType: "passport", documentNumber: "PA123456" })),
        now: at("2027-02-01"),
      },
      (s) => `sealed:${s}`,
    );
    expect((await queueReminders(db, at("2027-02-18"))).precheckin).toBe(0);
  });
});

describe("delivering messages", () => {
  it("claims only channels that can send, retries with backoff, gives up on permanent errors, and skips stale messages", async () => {
    const r = await booking();
    const now = at("2027-01-05", "04:00");
    expect(await claimMessages(db, { channels: [], now })).toEqual([]);
    const [email] = await claimMessages(db, { channels: ["email"], now });
    expect(email).toMatchObject({ channel: "email", status: "sending", attempts: 1 });
    // Claimed messages are not handed out twice.
    expect(await claimMessages(db, { channels: ["email"], now })).toEqual([]);

    await finishMessage(db, email, { ok: false, error: "500 boom" }, now);
    const [retry] = await db.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.id, email.id));
    expect(retry).toMatchObject({ status: "pending", lastError: "500 boom" });
    expect(retry.nextAttemptAt?.getTime()).toBe(now.getTime() + 60_000);
    expect(await claimMessages(db, { channels: ["email"], now })).toEqual([]);
    const [again] = await claimMessages(db, { channels: ["email"], now: new Date(now.getTime() + 61_000) });
    await finishMessage(db, again, { ok: false, error: "422 invalid", permanent: true }, now);
    expect((await db.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.id, email.id)))[0].status).toBe("failed");

    // WhatsApp never had keys: after 48 hours it is skipped rather than sent late.
    await claimMessages(db, { channels: ["email"], now: new Date(now.getTime() + 49 * 3_600_000) });
    const wa = (await outbox()).find((m) => m.channel === "whatsapp");
    expect(wa).toMatchObject({ status: "skipped", lastError: "not sent within 48 hours" });
    expect(r.id).toBeTruthy();
  });

  it("sends the full email and the WhatsApp template with a link to the booking page", async () => {
    const r = await booking();
    const emails: EmailMessage[] = [];
    const was: WhatsAppMessage[] = [];
    const result = await deliverPending(db, {
      now: at("2027-01-05", "04:00"),
      senders: {
        email: { send: async (m) => (emails.push(m), { ok: true, providerRef: "re_1" }) },
        whatsapp: { send: async (m) => (was.push(m), { ok: true, providerRef: "wamid.1" }) },
      },
    });
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(emails[0]).toMatchObject({ to: "ana@example.com", subject: `Pesanan ${r.code} terkonfirmasi` });
    expect(emails[0].text).toContain("Halo Ana,");
    expect(emails[0].text).toMatch(new RegExp(`/id/booking/${r.code}\\?t=`));
    expect(emails[0].html).toContain("River Pavilion");
    expect(was[0]).toMatchObject({ to: "6281123456789", template: "booking_confirmed", language: "id" });
    expect(was[0].params.slice(0, 3)).toEqual(["Ana", r.code, "River Pavilion · Ubud"]);
    expect((await outbox()).map((m) => [m.status, m.providerRef])).toEqual([
      ["sent", "re_1"],
      ["sent", "wamid.1"],
    ]);
  });
});

describe("providers", () => {
  it("calls Resend with an idempotency key and maps errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (status: number, body: unknown) => (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
    const message = { to: "a@example.com", subject: "S", html: "<p>H</p>", text: "T", idempotencyKey: "outbox-1" };
    expect(await createResendSender({ apiKey: "re_test", from: "Attara <b@example.com>", replyTo: "r@example.com" }, fake(200, { id: "e1" })).send(message)).toEqual({ ok: true, providerRef: "e1" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(headers["idempotency-key"]).toBe("outbox-1");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ from: "Attara <b@example.com>", to: ["a@example.com"], reply_to: "r@example.com" });
    expect(await createResendSender({ apiKey: "k", from: "f" }, fake(422, { message: "bad from" })).send(message)).toMatchObject({ ok: false, permanent: true });
    expect(await createResendSender({ apiKey: "k", from: "f" }, fake(429, {})).send(message)).toMatchObject({ ok: false, permanent: false });
  });

  it("calls the WhatsApp Cloud API with a template and its parameters", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fake = (async (url: string, init: RequestInit) => ((seen = { url, body: JSON.parse(String(init.body)) }), new Response(JSON.stringify({ messages: [{ id: "wamid.9" }] }), { status: 200 }))) as unknown as typeof fetch;
    const result = await createWhatsAppSender({ token: "t", phoneNumberId: "123", apiVersion: "v23.0" }, fake).send({ to: "628111", template: "booking_confirmed", language: "id", params: ["Ana", "ATR-1"] });
    expect(result).toEqual({ ok: true, providerRef: "wamid.9" });
    expect(seen).toEqual({
      url: "https://graph.facebook.com/v23.0/123/messages",
      body: {
        messaging_product: "whatsapp",
        to: "628111",
        type: "template",
        template: { name: "booking_confirmed", language: { code: "id" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "ATR-1" }] }] },
      },
    });
  });
});
