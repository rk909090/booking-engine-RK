import { brand } from "@/config/brand";
import { getDb } from "@/db/client";
import { buildIcs, exportEvents } from "@/domain/ical";

/**
 * A villa's availability as an iCal feed for other channels (Airbnb,
 * Booking.com…): /api/ical/<secret token>.ics. Lists only busy dates under a
 * neutral label; never guest names or prices.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/i, "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return new Response("not found", { status: 404 });
  const found = await exportEvents(getDb(), token);
  if (!found) return new Response("not found", { status: 404 });
  const body = buildIcs({ calendarName: `${brand.name} ${found.unit.code}`, label: "Not available", events: found.events, now: new Date() });
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${found.unit.code}.ics"`,
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
