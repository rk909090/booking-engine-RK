import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { brand } from "@/config/brand";
import { configuredSenders } from "@/lib/notifications/providers";

/*
 * Where password-setup links go. The link is a credential: running servers
 * never log it.
 * - When email is configured (Resend), it is emailed to the staff member.
 * - The code that asked for it (an invite on the users page, or the
 *   staff:invite script) also receives it, to hand over privately when email
 *   is not set up yet. Collection is scoped to that one call, so two invites
 *   at the same moment never see each other's link.
 */
export type OutgoingLink = { email: string; url: string; emailed?: boolean };

type Collector = (link: OutgoingLink) => void;

const scoped = new AsyncLocalStorage<Collector>();
let collector: Collector | undefined;

/** For scripts: receive every link produced in this process. */
export function setLinkCollector(next: Collector | undefined) {
  collector = next;
}

/** Runs fn and returns the links it produced (and only those). */
export async function collectLinks<T>(fn: () => Promise<T>): Promise<{ result: T; links: OutgoingLink[] }> {
  const links: OutgoingLink[] = [];
  const result = await scoped.run((link) => links.push(link), fn);
  return { result, links };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function deliverSetupLink(link: OutgoingLink) {
  let emailed = false;
  const sender = configuredSenders().email;
  if (sender) {
    const subject = `${brand.name}: buat password / set your password`;
    const text = [
      `Gunakan tautan ini untuk membuat password akun operasional ${brand.name}. Berlaku 24 jam.`,
      `Use this link to set the password of your ${brand.name} operations account. It is valid for 24 hours.`,
      "",
      link.url,
      "",
      "Abaikan email ini bila Anda tidak memintanya. / Ignore this email if you did not expect it.",
    ].join("\n");
    const html = `<p>Gunakan tautan ini untuk membuat password akun operasional ${escapeHtml(brand.name)}. Berlaku 24 jam.</p>
<p>Use this link to set the password of your ${escapeHtml(brand.name)} operations account. It is valid for 24 hours.</p>
<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a></p>
<p style="color:#6b6b63">Abaikan email ini bila Anda tidak memintanya. / Ignore this email if you did not expect it.</p>`;
    const sent = await sender.send({ to: link.email, subject, html, text, idempotencyKey: `setup:${createHash("sha256").update(link.url).digest("hex").slice(0, 32)}` });
    emailed = sent.ok;
  }
  const receive = scoped.getStore() ?? collector;
  if (receive) {
    receive({ ...link, emailed });
    return;
  }
  if (!emailed) {
    console.warn(`[auth] Email delivery is not configured; password link for ${link.email} was not sent. Issue a new one from the users page.`);
  }
}
