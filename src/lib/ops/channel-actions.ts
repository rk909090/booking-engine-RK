"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { sqlState } from "@/domain/booking";
import { syncFeed, validFeedUrl } from "@/domain/ical";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";

/*
 * Managing a villa's imported calendars (branch managers, within their
 * properties). Outcomes come back to the channels page as a short code.
 */

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard(form: FormData, unitId: string) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const back = (query: string): never => redirect(`/${lang}/ops/channels?${query}#unit-${unitId}`);
  const staff = await requireStaff(lang);
  if (!UUID.test(unitId)) back("error=not_found");
  const [unit] = await getDb().select({ propertyId: schema.units.propertyId }).from(schema.units).where(eq(schema.units.id, unitId)).limit(1);
  if (!unit || !can(staff.actor, "channels.manage", unit.propertyId).allowed) back("error=role");
  return { staff, back };
}

/** Adds another channel's calendar URL to a villa and reads it at once. */
export async function addFeedAction(form: FormData) {
  const unitId = field(form, "unitId");
  const { staff, back } = await guard(form, unitId);
  const name = field(form, "name").slice(0, 60) || "Channel";
  const url = validFeedUrl(field(form, "url"));
  if (!url) back("error=invalid_url");
  let feedId = "";
  try {
    const [feed] = await getDb()
      .insert(schema.icalFeeds)
      .values({ unitId, name, url: url!.toString(), createdBy: staff.staffId })
      .returning({ id: schema.icalFeeds.id });
    feedId = feed.id;
  } catch (error) {
    if (sqlState(error) === "23505") back("error=duplicate");
    throw error;
  }
  const result = await syncFeed(getDb(), feedId);
  back(result.ok ? "done=added" : "error=sync_failed");
}

/** Reads one imported calendar now. */
export async function syncFeedAction(form: FormData) {
  const unitId = field(form, "unitId");
  const { back } = await guard(form, unitId);
  const feedId = field(form, "feedId");
  if (!UUID.test(feedId)) back("error=not_found");
  const result = await syncFeed(getDb(), feedId);
  back(result.ok ? "done=synced" : "error=sync_failed");
}

/** Disconnects an imported calendar; its stays stop blocking the villa. */
export async function removeFeedAction(form: FormData) {
  const unitId = field(form, "unitId");
  const { back } = await guard(form, unitId);
  const feedId = field(form, "feedId");
  if (!UUID.test(feedId)) back("error=not_found");
  await getDb().delete(schema.icalFeeds).where(and(eq(schema.icalFeeds.id, feedId), eq(schema.icalFeeds.unitId, unitId)));
  back("done=removed");
}
