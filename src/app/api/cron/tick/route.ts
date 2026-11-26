import { timingSafeEqual } from "node:crypto";
import { brand } from "@/config/brand";
import { getDb } from "@/db/client";
import { expireHolds } from "@/domain/booking";
import { todayIn } from "@/domain/dates";
import { syncDueFeeds } from "@/domain/ical";
import { queueReminders } from "@/domain/notifications";
import { eraseExpiredDocuments } from "@/domain/pre-checkin";
import { deliverPending } from "@/lib/notifications/deliver";
import { queueDueReports } from "@/domain/report-schedule";
import { deliverReports } from "@/lib/ops/report-delivery";
import { channelStatus } from "@/lib/notifications/providers";

/**
 * Scheduled job, called every few minutes by a Hostinger cron job:
 *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/tick
 * Releases expired holds, reads the other channels' calendars (iCal), erases
 * expired guest document numbers, queues reminders, sends waiting messages,
 * and sends the scheduled reports that are due. Disabled until CRON_SECRET is set.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  const now = new Date();
  const holdsExpired = await expireHolds(db, now);
  const calendars = await syncDueFeeds(db, undefined, now);
  const documentsErased = await eraseExpiredDocuments(db, todayIn(brand.timezone, now), now);
  const reminders = await queueReminders(db, now);
  const delivery = await deliverPending(db, { now, limit: 50 });
  const reportsQueued = await queueDueReports(db, now);
  const reports = await deliverReports(db, { now });
  return Response.json({ ok: true, holdsExpired, calendars, documentsErased, reminders, delivery, reports: { queued: reportsQueued, ...reports }, channels: channelStatus() }, { headers: { "cache-control": "no-store" } });
}
