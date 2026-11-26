import "server-only";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { brand } from "@/config/brand";
import type * as schema from "@/db/schema";
import { finishRun, pendingRuns, recipientsFor, reportPeriod, type ReportKind } from "@/domain/report-schedule";
import { ratios, type Perf } from "@/domain/reports";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary } from "@/i18n/get-dictionary";
import type { Actor } from "@/lib/authz/permissions";
import { appUrl } from "@/lib/booking/access";
import { configuredSenders, type EmailSender } from "@/lib/notifications/providers";
import { todayCounts } from "./queries";
import { buildPace, buildReport } from "./reports";
import { paceXlsx, reportXlsx } from "./report-xlsx";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Property = typeof schema.properties.$inferSelect;

/*
 * The scheduled report emails: a short summary in the body (in the
 * recipient's language) and, for the weekly and monthly reports, the Excel
 * files. Figures come from the same report code as the Reports pages.
 */

/** Reads the property's figures as its branch manager would see them. */
const propertyActor = (propertyId: string): Actor => ({ staffId: "system", role: "branch_manager", isActive: true, propertyIds: [propertyId] });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type ReportEmail = { subject: string; html: string; text: string; attachments: Array<{ filename: string; content: string }> };

/** Builds one scheduled report email for a property, kind and send date. */
export async function buildReportEmail(property: Property, kind: ReportKind, today: string, locale: Locale): Promise<ReportEmail> {
  const d = await getDictionary(locale);
  const t = d.reportMail;
  const period = reportPeriod(kind, today);
  const actor = propertyActor(property.id);
  const money = (n: number) => formatMoney(n, locale);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const report = await buildReport(actor, { property: property.slug, from: period.from, to: period.to });
  const perfLines = (p: Perf, prev?: Perf): Array<[string, string]> => {
    const r = ratios(p);
    const pr = prev ? ratios(prev) : null;
    const vs = (now: string, before: string | null) => (before !== null ? `${now} (${format(t.lastYear, { value: before })})` : now);
    return [
      [t.occupancy, vs(pct(r.occupancy), pr ? pct(pr.occupancy) : null)],
      [t.nightsSold, vs(String(p.sold), prev ? String(prev.sold) : null)],
      [t.roomRevenue, vs(money(p.revenue), prev ? money(prev.revenue) : null)],
      [t.adr, vs(money(r.adr), pr ? money(pr.adr) : null)],
    ];
  };
  const sections: Array<{ title: string; lines: Array<[string, string]> }> = [];
  const attachments: ReportEmail["attachments"] = [];
  const periodLabel = period.from === period.to ? formatDate(period.from, locale) : formatDateRange(period.from, period.to, locale);
  const madeLines: Array<[string, string]> = [
    [t.bookingsMade, `${report.current.made.rows.length} · ${money(report.current.made.rows.reduce((s, r) => s + r.subtotalAmount - r.discountAmount, 0))}`],
    [t.cancellations, String(report.current.lost.cancelled.rows.length)],
  ];
  sections.push({ title: format(t.periodTitle, { period: periodLabel }), lines: [...perfLines(report.current.perf.totals, kind === "daily" ? undefined : report.previous.perf.totals), ...madeLines] });

  if (kind === "daily") {
    const c = await todayCounts(actor, today);
    sections.push({
      title: format(t.todayTitle, { date: formatDate(today, locale) }),
      lines: [
        [t.arrivals, String(c.arrivals)],
        [t.departures, String(c.departures)],
        [t.inHouse, String(c.inHouse)],
        [t.requestsPending, String(c.requestsPending)],
        [t.depositsOverdue, String(c.depositsOverdue)],
      ],
    });
  } else {
    attachments.push({ filename: `report-${property.slug}-${period.from}-${period.to}.xlsx`, content: Buffer.from(reportXlsx(report)).toString("base64") });
  }
  if (kind === "weekly") {
    const pace = await buildPace(actor, { property: property.slug, months: "3" });
    const weekAgo = (key: string) => pace.weekAgo.series.find((s) => s.key === key);
    sections.push({
      title: t.paceTitle,
      lines: pace.current.series.map((s) => [
        formatDate(`${s.key}-01`, locale, { month: "long", year: "numeric" }),
        `${pct(ratios(s).occupancy)} · ${money(s.revenue)} · ${format(t.pickup, { nights: s.sold - (weekAgo(s.key)?.sold ?? 0) })}`,
      ]),
    });
    attachments.push({ filename: `pace-${property.slug}-${pace.from}-${pace.to}.xlsx`, content: Buffer.from(paceXlsx(pace)).toString("base64") });
  }

  const subject = format((t.subjects as Record<string, string>)[kind], { property: property.name, period: kind === "monthly" ? formatDate(period.from, locale, { month: "long", year: "numeric" }) : periodLabel });
  const link = `${appUrl()}/${locale}/ops/reports?property=${property.slug}&from=${period.from}&to=${period.to}`;
  const text = [subject, "", ...sections.flatMap((s) => [s.title, ...s.lines.map(([k, v]) => `- ${k}: ${v}`), ""]), attachments.length ? t.attached : "", `${t.open}: ${link}`, "", format(t.footer, { brand: brand.name })].join("\n");
  const html = `<!doctype html><html lang="${locale}"><body style="margin:0;background:#f6f1e7;font-family:Arial,Helvetica,sans-serif;color:#1f2a24">
<div style="max-width:600px;margin:0 auto;padding:24px">
<p style="font-family:Georgia,serif;font-size:20px;color:#1d4d43;margin:0 0 16px">${escapeHtml(brand.name)}</p>
<div style="background:#ffffff;border:1px solid #e5dccb;border-radius:12px;padding:24px;font-size:14px;line-height:1.5">
<p style="margin:0 0 16px;font-size:16px;font-weight:bold">${escapeHtml(subject)}</p>
${sections
  .map(
    (s) => `<p style="margin:16px 0 6px;color:#9a5b3c;font-size:12px;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(s.title)}</p>
<table style="width:100%;border-collapse:collapse">${s.lines.map(([k, v]) => `<tr><td style="padding:5px 0;color:#6b6b63;border-top:1px solid #efe8da">${escapeHtml(k)}</td><td style="padding:5px 0;text-align:right;border-top:1px solid #efe8da">${escapeHtml(v)}</td></tr>`).join("")}</table>`,
  )
  .join("\n")}
${attachments.length ? `<p style="margin:16px 0 0;color:#6b6b63">${escapeHtml(t.attached)}</p>` : ""}
<p style="margin:20px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1d4d43;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px">${escapeHtml(t.open)}</a></p>
</div>
<p style="font-size:12px;color:#8a8a80;margin:16px 0 0">${escapeHtml(format(t.footer, { brand: brand.name }))}</p>
</div></body></html>`;
  return { subject, html, text, attachments };
}

/** Sends the scheduled reports that are due. Without an email sender they wait (and are skipped after a few days). */
export async function deliverReports(db: AnyDb, options: { now?: Date; sender?: EmailSender | null } = {}) {
  const now = options.now ?? new Date();
  const sender = options.sender === undefined ? configuredSenders().email : options.sender;
  const runs = await pendingRuns(db, now);
  if (!sender) return { sent: 0, failed: 0, waiting: runs.length };
  let sent = 0;
  let failed = 0;
  for (const { run, property } of runs) {
    const kind = run.kind as ReportKind;
    // A monthly run's key is the month reported; it is sent on the 1st of the following month.
    const sendDay = kind === "monthly" ? nextMonthFirst(run.periodKey) : run.periodKey;
    const recipients = await recipientsFor(db, property.id, kind);
    if (!recipients.length) {
      await finishRun(db, { runId: run.id, ok: true, recipients: 0, now });
      continue;
    }
    const emails = new Map<Locale, ReportEmail>();
    let error: string | null = null;
    let permanent = false;
    for (const r of recipients) {
      const email = emails.get(r.locale) ?? (await buildReportEmail(property, kind, sendDay, r.locale));
      emails.set(r.locale, email);
      const result = await sender.send({ to: r.email, subject: email.subject, html: email.html, text: email.text, attachments: email.attachments, idempotencyKey: `report:${run.id}:${r.email}` });
      if (!result.ok) {
        error = result.error;
        permanent = permanent || result.permanent;
      }
    }
    await finishRun(db, { runId: run.id, ok: error === null, recipients: recipients.length, error, permanent, now });
    if (error === null) sent++;
    else failed++;
  }
  return { sent, failed, waiting: 0 };
}

function nextMonthFirst(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
