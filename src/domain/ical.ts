import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { addDays, isIsoDate, todayIn } from "./dates";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Two-way calendar sync with other channels (Airbnb, Booking.com, VRBO) by
 * iCal, per villa:
 * - Export: each villa has a secret feed URL listing the nights it is not
 *   available (our bookings, maintenance, and stays imported from other
 *   channels). It never contains guest names: every event is "Not available".
 * - Import: the branch manager adds each channel's export URL to the villa.
 *   Feeds are read every SYNC_MINUTES by the scheduled job (or on demand);
 *   their events block those nights here like a booking does.
 * iCal is polled, so a booking can still arrive from two channels within the
 * same few minutes. Overlaps are listed as conflicts for staff to resolve;
 * nothing is cancelled automatically.
 */

export const SYNC_MINUTES = 15;
const MAX_FEED_BYTES = 2_000_000;
/** Imported events that ended before this many days ago are dropped. */
const KEEP_PAST_DAYS = 30;

export type ParsedEvent = { uid: string; startDate: string; endDate: string; summary: string | null };

function unescapeText(value: string) {
  return value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

/** The calendar date of an iCal DATE or DATE-TIME value, at the property for UTC times. */
function icalDate(value: string, params: string, timezone: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const date = `${y}-${mo}-${d}`;
  if (!isIsoDate(date)) return null;
  if (h === undefined || !z || /TZID=/i.test(params)) return date; // a date, or a local time: its date part
  const instant = new Date(`${date}T${h}:${mi}:${s}Z`);
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** Reads the busy periods of an iCal calendar. Cancelled and malformed events are left out. */
export function parseIcs(text: string, timezone: string): ParsedEvent[] {
  // Unfold continuation lines (RFC 5545: a line starting with a space or tab continues the previous one).
  const lines = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: ParsedEvent[] = [];
  let current: Record<string, { value: string; params: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT") {
      if (current) {
        const start = current.DTSTART && icalDate(current.DTSTART.value, current.DTSTART.params, timezone);
        let end = current.DTEND && icalDate(current.DTEND.value, current.DTEND.params, timezone);
        const cancelled = current.STATUS?.value.toUpperCase() === "CANCELLED";
        if (start && !end) end = addDays(start, 1);
        if (start && end && end <= start) end = addDays(start, 1);
        if (start && end && !cancelled) {
          const summary = current.SUMMARY ? unescapeText(current.SUMMARY.value).slice(0, 200) : null;
          const uid = current.UID?.value.trim() || `${start}/${end}/${summary ?? ""}`;
          events.push({ uid: uid.slice(0, 300), startDate: start, endDate: end, summary });
        }
      }
      current = null;
    } else if (current) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const head = line.slice(0, colon);
      const [name, ...params] = head.split(";");
      current[name.toUpperCase()] = { value: line.slice(colon + 1), params: params.join(";") };
    }
  }
  return events;
}

const fold = (line: string) => {
  // Lines longer than 75 octets are folded (content here is ASCII).
  const out: string[] = [];
  for (let i = 0; i < line.length; i += i === 0 ? 75 : 74) out.push((i === 0 ? "" : " ") + line.slice(i, i === 0 ? 75 : i + 74));
  return out.join("\r\n");
};
const icalDay = (date: string) => date.replace(/-/g, "");

/** An iCal calendar of busy periods; each summary is the same neutral label (no guest data). */
export function buildIcs(input: { calendarName: string; label: string; events: Array<{ uid: string; startDate: string; endDate: string }>; now: Date }): string {
  const stamp = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Attara Hospitality//Booking Engine//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${input.calendarName.replace(/[\r\n,;]/g, " ")}`,
  ];
  for (const e of input.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icalDay(e.startDate)}`,
      `DTEND;VALUE=DATE:${icalDay(e.endDate)}`,
      `SUMMARY:${input.label}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** The villa's export token, created on first use. */
export async function exportToken(db: AnyDb, unitId: string): Promise<string> {
  const [unit] = await db.select({ token: schema.units.icalExportToken }).from(schema.units).where(eq(schema.units.id, unitId));
  if (unit?.token) return unit.token;
  const token = randomBytes(24).toString("base64url");
  await db.update(schema.units).set({ icalExportToken: token }).where(and(eq(schema.units.id, unitId), isNull(schema.units.icalExportToken)));
  const [after] = await db.select({ token: schema.units.icalExportToken }).from(schema.units).where(eq(schema.units.id, unitId));
  return after!.token!;
}

/** What the export feed of a villa lists: bookings, open maintenance, and stays imported from other channels. */
export async function exportEvents(db: AnyDb, token: string, now: Date = new Date()) {
  const [unit] = await db
    .select({ id: schema.units.id, code: schema.units.code, timezone: schema.properties.timezone })
    .from(schema.units)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.units.propertyId))
    .where(and(eq(schema.units.icalExportToken, token), eq(schema.units.isActive, true)));
  if (!unit) return null;
  const since = addDays(todayIn(unit.timezone, now), -KEEP_PAST_DAYS);
  const [bookings, blocks, imported] = await Promise.all([
    db
      .select({ id: schema.reservations.id, startDate: schema.reservations.checkIn, endDate: schema.reservations.checkOut })
      .from(schema.reservations)
      .where(
        and(
          eq(schema.reservations.unitId, unit.id),
          gt(schema.reservations.checkOut, since),
          sql`(${schema.reservations.status} IN ('confirmed', 'in_house', 'checked_out')
            OR (${schema.reservations.status} = 'hold' AND ${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
        ),
      ),
    db
      .select({ id: schema.unitBlocks.id, startDate: schema.unitBlocks.startDate, endDate: schema.unitBlocks.endDate })
      .from(schema.unitBlocks)
      .where(and(eq(schema.unitBlocks.unitId, unit.id), eq(schema.unitBlocks.status, "open"), gt(schema.unitBlocks.endDate, since))),
    db
      .select({ id: schema.icalEvents.id, startDate: schema.icalEvents.startDate, endDate: schema.icalEvents.endDate })
      .from(schema.icalEvents)
      .where(and(eq(schema.icalEvents.unitId, unit.id), gt(schema.icalEvents.endDate, since))),
  ]);
  const events = [
    ...bookings.map((b) => ({ uid: `booking-${b.id}@attara`, startDate: b.startDate, endDate: b.endDate })),
    ...blocks.map((b) => ({ uid: `block-${b.id}@attara`, startDate: b.startDate, endDate: b.endDate })),
    ...imported.map((e) => ({ uid: `channel-${e.id}@attara`, startDate: e.startDate, endDate: e.endDate })),
  ].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return { unit, events };
}

/** Feed URLs must be https and not point at this machine or a private network. */
export function validFeedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null; // IP literals: channels publish host names
  return url;
}

export type FetchText = (url: string) => Promise<string>;

/** Default reader: https only, 15 s timeout, 2 MB cap, no redirects to other schemes. */
export const fetchFeedText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow", headers: { accept: "text/calendar, */*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.url && !validFeedUrl(res.url)) throw new Error("redirected to a URL that is not allowed");
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error("calendar too large");
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("not an iCal calendar");
  return text;
};

/**
 * Reads one imported calendar and replaces its events (events the channel no
 * longer lists, e.g. cancelled stays, are removed). Errors are recorded on the
 * feed and leave its previous events in place.
 */
export async function syncFeed(db: AnyDb, feedId: string, fetchText: FetchText = fetchFeedText, now: Date = new Date()) {
  const [row] = await db
    .select({ feed: schema.icalFeeds, timezone: schema.properties.timezone })
    .from(schema.icalFeeds)
    .innerJoin(schema.units, eq(schema.units.id, schema.icalFeeds.unitId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.units.propertyId))
    .where(eq(schema.icalFeeds.id, feedId));
  if (!row) return { ok: false as const, error: "not_found" };
  const { feed, timezone } = row;
  let parsed: ParsedEvent[];
  try {
    if (!validFeedUrl(feed.url)) throw new Error("URL not allowed");
    parsed = parseIcs(await fetchText(feed.url), timezone);
  } catch (error) {
    // Network errors hide the reason (DNS, TLS, timeout) in `cause`.
    const cause = error instanceof Error && error.cause ? ` (${(error.cause as { code?: string; message?: string }).code ?? (error.cause as Error).message})` : "";
    const message = `${error instanceof Error ? error.message : String(error)}${cause}`.slice(0, 300);
    await db.update(schema.icalFeeds).set({ lastSyncedAt: now, lastStatus: "error", lastError: message, updatedAt: now }).where(eq(schema.icalFeeds.id, feed.id));
    return { ok: false as const, error: message };
  }
  const since = addDays(todayIn(timezone, now), -KEEP_PAST_DAYS);
  // One row per UID; the last one in the file wins.
  const events = [...new Map(parsed.filter((e) => e.endDate > since).map((e) => [e.uid, e])).values()];
  await db.transaction(async (tx) => {
    if (events.length) {
      for (const e of events) {
        await tx
          .insert(schema.icalEvents)
          .values({ feedId: feed.id, unitId: feed.unitId, uid: e.uid, startDate: e.startDate, endDate: e.endDate, summary: e.summary, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [schema.icalEvents.feedId, schema.icalEvents.uid],
            set: { startDate: e.startDate, endDate: e.endDate, summary: e.summary, updatedAt: now },
          });
      }
      await tx.delete(schema.icalEvents).where(and(eq(schema.icalEvents.feedId, feed.id), notInArray(schema.icalEvents.uid, events.map((e) => e.uid))));
    } else {
      await tx.delete(schema.icalEvents).where(eq(schema.icalEvents.feedId, feed.id));
    }
    await tx
      .update(schema.icalFeeds)
      .set({ lastSyncedAt: now, lastStatus: "ok", lastError: null, eventCount: events.length, updatedAt: now })
      .where(eq(schema.icalFeeds.id, feed.id));
  });
  return { ok: true as const, events: events.length };
}

/** Syncs every active feed not read in the last SYNC_MINUTES (the scheduled job). */
export async function syncDueFeeds(db: AnyDb, fetchText: FetchText = fetchFeedText, now: Date = new Date()) {
  const due = await db
    .select({ id: schema.icalFeeds.id })
    .from(schema.icalFeeds)
    .where(
      and(
        eq(schema.icalFeeds.isActive, true),
        or(isNull(schema.icalFeeds.lastSyncedAt), lt(schema.icalFeeds.lastSyncedAt, new Date(now.getTime() - SYNC_MINUTES * 60_000))),
      ),
    )
    .orderBy(asc(schema.icalFeeds.lastSyncedAt))
    .limit(50);
  let ok = 0;
  let failed = 0;
  for (const f of due) {
    const result = await syncFeed(db, f.id, fetchText, now);
    if (result.ok) ok++;
    else failed++;
  }
  return { ok, failed };
}

export type CalendarConflict = {
  eventId: string;
  unitId: string;
  unitCode: string;
  feedName: string;
  startDate: string;
  endDate: string;
  /** Our bookings on the same nights. */
  codes: string[];
  /** Other imported calendars with a stay on the same nights. */
  otherFeeds: string[];
};

/** Imported stays (from today on) that overlap our bookings or another channel's stays on the same villa. */
export async function calendarConflicts(db: AnyDb, input: { propertyIds: string[]; today: string; now?: Date }): Promise<CalendarConflict[]> {
  if (input.propertyIds.length === 0) return [];
  const now = input.now ?? new Date();
  const events = await db
    .select({
      id: schema.icalEvents.id,
      unitId: schema.icalEvents.unitId,
      feedId: schema.icalEvents.feedId,
      startDate: schema.icalEvents.startDate,
      endDate: schema.icalEvents.endDate,
      unitCode: schema.units.code,
      feedName: schema.icalFeeds.name,
    })
    .from(schema.icalEvents)
    .innerJoin(schema.units, eq(schema.units.id, schema.icalEvents.unitId))
    .innerJoin(schema.icalFeeds, eq(schema.icalFeeds.id, schema.icalEvents.feedId))
    .where(and(inArray(schema.units.propertyId, input.propertyIds), gt(schema.icalEvents.endDate, input.today)))
    .orderBy(asc(schema.icalEvents.startDate));
  const out: CalendarConflict[] = [];
  for (const e of events) {
    const overlap = (start: unknown, end: unknown) => sql`daterange(${start}, ${end}, '[)') && daterange(${e.startDate}::date, ${e.endDate}::date, '[)')`;
    const [bookings, others] = await Promise.all([
      db
        .select({ code: schema.reservations.code })
        .from(schema.reservations)
        .where(
          and(
            eq(schema.reservations.unitId, e.unitId),
            overlap(schema.reservations.checkIn, schema.reservations.checkOut),
            sql`(${schema.reservations.status} IN ('confirmed', 'in_house')
              OR (${schema.reservations.status} = 'hold' AND ${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
          ),
        ),
      db
        .select({ name: schema.icalFeeds.name })
        .from(schema.icalEvents)
        .innerJoin(schema.icalFeeds, eq(schema.icalFeeds.id, schema.icalEvents.feedId))
        .where(and(eq(schema.icalEvents.unitId, e.unitId), ne(schema.icalEvents.feedId, e.feedId), gte(schema.icalEvents.endDate, e.startDate), overlap(schema.icalEvents.startDate, schema.icalEvents.endDate))),
    ]);
    if (bookings.length || others.length) {
      out.push({
        eventId: e.id,
        unitId: e.unitId,
        unitCode: e.unitCode,
        feedName: e.feedName,
        startDate: e.startDate,
        endDate: e.endDate,
        codes: bookings.map((b) => b.code),
        otherFeeds: [...new Set(others.map((o) => o.name))],
      });
    }
  }
  return out;
}
