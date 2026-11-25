import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment } from "@/domain/booking";
import { createXenditProvider, XenditError, type CheckoutState } from "@/lib/payments/provider";
import { processXenditSessionEvent } from "@/lib/payments/xendit-webhook";
import { createTestDb, type TestDb } from "./test-db";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A stand-in for fetch that records requests and answers from a queue. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("Xendit Payment Sessions client", () => {
  const expiresAt = new Date("2027-01-01T04:00:00Z");
  const request = {
    amount: 3_900_000,
    currency: "IDR",
    description: "Attara · ATR-TEST",
    customer: { name: "Guest" },
    successUrl: "https://be.example.com/id/booking/ATR-TEST?t=x",
    failureUrl: "https://be.example.com/id/booking/ATR-TEST?t=x",
    expiresAt,
    locale: "id" as const,
  };

  it("creates a hosted payment-link session with basic auth and returns its id and link", async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, body: { payment_session_id: "ps-abc", status: "ACTIVE", payment_link_url: "https://dev.xen.to/x", expires_at: "2027-01-01T04:00:00.000Z" } },
    ]);
    const xendit = createXenditProvider("xnd_development_TEST", impl);
    expect(await xendit.createCheckout(request)).toEqual({ providerRef: "ps-abc", checkoutUrl: "https://dev.xen.to/x", expiresAt });
    expect(calls[0].url).toBe("https://api.xendit.co/sessions");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("xnd_development_TEST:").toString("base64")}`);
    expect(calls[0].body).toMatchObject({
      session_type: "PAY",
      mode: "PAYMENT_LINK",
      amount: 3_900_000,
      currency: "IDR",
      country: "ID",
      success_return_url: request.successUrl,
      cancel_return_url: request.failureUrl,
      expires_at: "2027-01-01T04:00:00.000Z",
    });
    expect((calls[0].body as { reference_id: string }).reference_id).toMatch(/^pay_/);
  });

  it("reports Xendit's error code, and treats closing an already closed session as done", async () => {
    const { impl } = fakeFetch([
      { status: 400, body: { error_code: "API_VALIDATION_ERROR", message: "amount is required" } },
      { status: 422, body: { error_code: "INVALID_SESSION_STATUS", message: "not active" } },
      { status: 401, body: { error_code: "INVALID_API_KEY", message: "bad key" } },
    ]);
    const xendit = createXenditProvider("k", impl);
    await expect(xendit.createCheckout(request)).rejects.toMatchObject({ httpStatus: 400, errorCode: "API_VALIDATION_ERROR" });
    await expect(xendit.cancelCheckout("ps-done")).resolves.toBeUndefined();
    await expect(xendit.cancelCheckout("ps-x")).rejects.toBeInstanceOf(XenditError);
  });

  it("maps session statuses", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { payment_session_id: "ps-1", status: "COMPLETED", amount: 100, currency: "IDR" } },
      { status: 200, body: { payment_session_id: "ps-1", status: "CANCELED" } },
    ]);
    const xendit = createXenditProvider("k", impl);
    expect(await xendit.getCheckout("ps-1")).toEqual({ status: "paid", amount: 100, currency: "IDR" });
    expect(await xendit.getCheckout("ps-1")).toEqual({ status: "cancelled", amount: null, currency: null });
    expect(calls[0]).toMatchObject({ url: "https://api.xendit.co/sessions/ps-1", method: "GET" });
  });
});

describe("Xendit webhook", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let typeId: string;

  beforeAll(async () => {
    const test = await createTestDb();
    db = test.db;
    close = () => test.client.close();
    await seedSampleData(db);
    [{ id: typeId }] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  });
  afterAll(async () => close());
  beforeEach(async () => {
    for (const table of [schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) await db.delete(table);
  });

  const now = new Date("2027-01-01T03:00:00Z");

  async function heldWithSession(ref: string) {
    const h = await createHold(db, {
      unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 2, children: 0,
      guest: { fullName: "G", email: "g@example.com" }, locale: "en", source: "website", now,
    });
    if (!h.ok) throw new Error();
    await createPendingPayment(db, { reservationId: h.reservation.id, provider: "xendit", providerRef: ref, purpose: "deposit", amount: h.reservation.depositAmount, checkoutUrl: "https://dev.xen.to/x", expiresAt: null });
    return h.reservation;
  }

  const xenditSaying = (state: CheckoutState | Error) => ({
    calls: 0,
    async getCheckout() {
      this.calls += 1;
      if (state instanceof Error) throw state;
      return state;
    },
  });

  const event = (id: unknown, name = "payment_session.completed") => ({ event: name, data: { payment_session_id: id, status: "COMPLETED", amount: 1 } });

  it("confirms the booking only after Xendit's API says the session is completed, once", async () => {
    const r = await heldWithSession("ps-ok");
    const xendit = xenditSaying({ status: "paid", amount: r.depositAmount, currency: "IDR" });
    expect(await processXenditSessionEvent(db, xendit, event("ps-ok"), now)).toEqual({ status: 200, body: { received: true, outcome: "confirmed" } });
    expect(await processXenditSessionEvent(db, xendit, event("ps-ok"), now)).toEqual({ status: 200, body: { received: true, outcome: "already_processed" } });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after).toMatchObject({ status: "confirmed", amountPaid: r.depositAmount });
  });

  it("ignores what the body claims: a session still active stays unpaid", async () => {
    const r = await heldWithSession("ps-active");
    const result = await processXenditSessionEvent(db, xenditSaying({ status: "pending", amount: r.depositAmount, currency: "IDR" }), event("ps-active"), now);
    expect(result).toEqual({ status: 200, body: { received: true, status: "pending" } });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after.status).toBe("hold");
  });

  it("refuses a different amount or currency", async () => {
    const r = await heldWithSession("ps-amount");
    expect((await processXenditSessionEvent(db, xenditSaying({ status: "paid", amount: 1000, currency: "IDR" }), event("ps-amount"), now)).body.outcome).toBe("amount_mismatch");
    const r2 = await heldWithSession("ps-usd");
    expect((await processXenditSessionEvent(db, xenditSaying({ status: "paid", amount: r2.depositAmount, currency: "USD" }), event("ps-usd"), now)).body.outcome).toBe("amount_mismatch");
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after.status).toBe("hold");
  });

  it("marks expired sessions, ignores unknown ones, and asks for a retry when Xendit cannot be reached", async () => {
    await heldWithSession("ps-exp");
    await processXenditSessionEvent(db, xenditSaying({ status: "expired", amount: null, currency: null }), event("ps-exp", "payment_session.expired"), now);
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.providerRef, "ps-exp"));
    expect(payment.status).toBe("expired");

    const never = xenditSaying({ status: "paid", amount: 1, currency: "IDR" });
    expect(await processXenditSessionEvent(db, never, event("ps-unknown"), now)).toEqual({ status: 200, body: { ignored: "unknown_session" } });
    expect(await processXenditSessionEvent(db, never, { event: "x" }, now)).toEqual({ status: 200, body: { ignored: "no_session_id" } });
    expect(never.calls).toBe(0);

    await heldWithSession("ps-down");
    expect((await processXenditSessionEvent(db, xenditSaying(new Error("timeout")), event("ps-down"), now)).status).toBe(502);
  });
});
