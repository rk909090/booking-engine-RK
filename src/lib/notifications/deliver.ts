import "server-only";
import { after } from "next/server";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { claimMessages, finishMessage, MESSAGE_KINDS, type Channel } from "@/domain/notifications";
import { configuredSenders, type EmailSender, type WhatsAppSender } from "./providers";
import { loadMessageContext, renderEmail, renderWhatsApp } from "./render";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Sends what is waiting in the outbox on the channels that have keys. Safe to
 * run concurrently and repeatedly (claims are exclusive, sends idempotent
 * where the provider supports it).
 */
export async function deliverPending(
  db: AnyDb,
  options: { now?: Date; limit?: number; senders?: { email: EmailSender | null; whatsapp: WhatsAppSender | null } } = {},
): Promise<{ sent: number; failed: number }> {
  const senders = options.senders ?? configuredSenders();
  const channels = (["email", "whatsapp"] as Channel[]).filter((c) => senders[c]);
  const messages = await claimMessages(db, { channels, now: options.now, limit: options.limit });
  let sent = 0;
  let failed = 0;
  for (const message of messages) {
    let outcome: Awaited<ReturnType<EmailSender["send"]>>;
    const ctx = message.reservationId ? await loadMessageContext(db, message.reservationId) : null;
    if (!ctx || !(MESSAGE_KINDS as readonly string[]).includes(message.kind)) {
      outcome = { ok: false, error: "booking or message kind not found", permanent: true };
    } else if (message.channel === "email") {
      outcome = await senders.email!.send(await renderEmail(message, ctx));
    } else {
      outcome = await senders.whatsapp!.send(renderWhatsApp(message, ctx));
    }
    await finishMessage(db, message, outcome, new Date());
    if (outcome.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

/**
 * After the response is sent, delivers what the request just queued. Does
 * nothing when no channel has keys (the messages wait for the scheduled job).
 */
export function deliverSoon() {
  const senders = configuredSenders();
  if (!senders.email && !senders.whatsapp) return;
  after(async () => {
    try {
      await deliverPending(getDb(), { senders, limit: 10 });
    } catch (error) {
      console.error("[notifications] delivery failed", error);
    }
  });
}
