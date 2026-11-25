import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { recordPaymentPaid } from "@/domain/booking";
import { verifyXenditCallbackToken } from "@/lib/payments/provider";

/**
 * Xendit invoice notifications. Authenticity is checked with the account's
 * callback token (x-callback-token). Duplicates are harmless: payments are
 * unique per (provider, external_id) and recordPaymentPaid is idempotent.
 */
export async function POST(request: Request) {
  if (!verifyXenditCallbackToken(request.headers.get("x-callback-token"))) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { external_id?: string; status?: string; amount?: number; paid_amount?: number; paid_at?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!body.external_id || !body.status) return new Response("bad request", { status: 400 });

  const db = getDb();
  if (body.status === "PAID" || body.status === "SETTLED") {
    const outcome = await recordPaymentPaid(db, {
      provider: "xendit",
      providerRef: body.external_id,
      amount: Math.round(body.paid_amount ?? body.amount ?? 0),
      paidAt: body.paid_at ? new Date(body.paid_at) : new Date(),
      raw: body,
    });
    if (outcome.kind === "unknown_payment") return new Response("unknown payment", { status: 404 });
    return Response.json({ received: true, outcome: outcome.kind });
  }

  if (body.status === "EXPIRED") {
    await db
      .update(schema.payments)
      .set({ status: "expired", raw: body, updatedAt: new Date() })
      .where(
        and(
          eq(schema.payments.provider, "xendit"),
          eq(schema.payments.providerRef, body.external_id),
          eq(schema.payments.status, "pending"),
        ),
      );
  }
  return Response.json({ received: true });
}
