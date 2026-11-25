import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { getPaymentProvider } from "./provider";

/** Payment links of a booking still open at the provider. Read before an action that makes them unnecessary. */
export async function openCheckouts(reservationId: string) {
  return getDb()
    .select({ provider: schema.payments.provider, providerRef: schema.payments.providerRef })
    .from(schema.payments)
    .where(and(eq(schema.payments.reservationId, reservationId), eq(schema.payments.status, "pending"), inArray(schema.payments.provider, ["xendit", "simulated"])));
}

/**
 * Closes payment links that are no longer wanted (the desk took the money,
 * or the booking was cancelled), so the guest cannot pay twice. Best effort
 * at the provider: a failure is logged, and a payment that still arrives is
 * recorded and owed back as a refund.
 */
export async function closeCheckouts(reservationId: string, checkouts: Array<{ provider: string; providerRef: string }>) {
  if (checkouts.length === 0) return;
  const provider = getPaymentProvider();
  for (const c of checkouts) {
    if (c.provider !== provider.name) continue;
    try {
      await provider.cancelCheckout(c.providerRef);
    } catch (error) {
      console.error("[payments] could not close checkout", c.providerRef, error);
    }
  }
  await getDb()
    .update(schema.payments)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(schema.payments.reservationId, reservationId),
        eq(schema.payments.status, "pending"),
        inArray(
          schema.payments.providerRef,
          checkouts.map((c) => c.providerRef),
        ),
      ),
    );
}
