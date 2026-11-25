import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { recordPaymentPaid } from "@/domain/booking";
import type { CheckoutState } from "./provider";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Handles a Xendit Payment Session notification (payment_session.completed /
 * payment_session.expired). The body only tells us which session changed: its
 * status and amount are read back from Xendit's API with our secret key, so a
 * forged or replayed body cannot mark anything paid. Duplicates are harmless
 * because recordPaymentPaid is idempotent per (provider, session id).
 *
 * Returns the HTTP status and body for Xendit. A failure to reach Xendit
 * answers 502 so Xendit retries later; payments we do not know answer 200 so
 * Xendit stops retrying them.
 */
export async function processXenditSessionEvent(
  db: AnyDb,
  xendit: { getCheckout(providerRef: string): Promise<CheckoutState> },
  payload: unknown,
  now: Date = new Date(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const data = (payload as { data?: { payment_session_id?: unknown } } | null)?.data;
  const sessionId = typeof data?.payment_session_id === "string" ? data.payment_session_id : null;
  if (!sessionId) return { status: 200, body: { ignored: "no_session_id" } };

  const [payment] = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.provider, "xendit"), eq(schema.payments.providerRef, sessionId)))
    .limit(1);
  if (!payment) return { status: 200, body: { ignored: "unknown_session" } };

  let state: CheckoutState;
  try {
    state = await xendit.getCheckout(sessionId);
  } catch (error) {
    console.error("[xendit] could not read session", sessionId, error);
    return { status: 502, body: { error: "session_lookup_failed" } };
  }

  if (state.status === "paid") {
    // A different currency counts as a different amount, so it is refused as a mismatch.
    const amount = state.currency && state.currency !== payment.currency ? -1 : (state.amount ?? payment.amount);
    const outcome = await recordPaymentPaid(db, {
      provider: "xendit",
      providerRef: sessionId,
      amount,
      paidAt: now,
      raw: { event: (payload as { event?: unknown }).event ?? null, session: state },
    });
    return { status: 200, body: { received: true, outcome: outcome.kind } };
  }

  if (state.status === "expired" || state.status === "cancelled") {
    await db
      .update(schema.payments)
      .set({ status: state.status, updatedAt: now })
      .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, "pending")));
  }
  return { status: 200, body: { received: true, status: state.status } };
}
