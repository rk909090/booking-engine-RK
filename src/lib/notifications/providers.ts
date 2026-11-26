import "server-only";

/*
 * Delivery providers. Each one is "not configured" until its keys are set, so
 * the app runs without them and messages wait in the outbox:
 * - Email via Resend: RESEND_API_KEY, EMAIL_FROM (an address on a domain
 *   verified in Resend), optional EMAIL_REPLY_TO.
 * - WhatsApp Cloud API (Meta): WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 *   optional WHATSAPP_API_VERSION. Messages use pre-approved templates.
 */

export type SendResult = { ok: true; providerRef: string | null } | { ok: false; error: string; permanent: boolean };
type Fetch = typeof fetch;

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  /** Files sent with the email (content base64-encoded), e.g. report workbooks. */
  attachments?: Array<{ filename: string; content: string }>;
};
export type WhatsAppMessage = { to: string; template: string; language: string; params: string[] };

export type EmailSender = { send(message: EmailMessage): Promise<SendResult> };
export type WhatsAppSender = { send(message: WhatsAppMessage): Promise<SendResult> };

/** 4xx other than 408/429 will not succeed on retry. */
const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

async function errorText(res: Response) {
  const body = await res.text().catch(() => "");
  return `${res.status} ${body.slice(0, 300)}`;
}

export function createResendSender(config: { apiKey: string; from: string; replyTo?: string | null }, fetchImpl: Fetch = fetch): EmailSender {
  return {
    async send(m) {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
            // The outbox id: a retried request never sends the email twice.
            "idempotency-key": m.idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [m.to],
            subject: m.subject,
            html: m.html,
            text: m.text,
            ...(m.attachments?.length ? { attachments: m.attachments } : {}),
            ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          }),
        });
        if (!res.ok) return { ok: false, error: `resend ${await errorText(res)}`, permanent: permanent(res.status) };
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        return { ok: true, providerRef: json.id ?? null };
      } catch (error) {
        return { ok: false, error: `resend ${String(error).slice(0, 200)}`, permanent: false };
      }
    },
  };
}

export function createWhatsAppSender(config: { token: string; phoneNumberId: string; apiVersion?: string }, fetchImpl: Fetch = fetch): WhatsAppSender {
  const url = `https://graph.facebook.com/${config.apiVersion ?? "v23.0"}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  return {
    async send(m) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: m.to,
            type: "template",
            template: {
              name: m.template,
              language: { code: m.language },
              components: m.params.length ? [{ type: "body", parameters: m.params.map((text) => ({ type: "text", text })) }] : [],
            },
          }),
        });
        if (!res.ok) return { ok: false, error: `whatsapp ${await errorText(res)}`, permanent: permanent(res.status) };
        const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> };
        return { ok: true, providerRef: json.messages?.[0]?.id ?? null };
      } catch (error) {
        return { ok: false, error: `whatsapp ${String(error).slice(0, 200)}`, permanent: false };
      }
    },
  };
}

/** The configured senders (null when a channel's keys are not set). */
export function configuredSenders(env: NodeJS.ProcessEnv = process.env): { email: EmailSender | null; whatsapp: WhatsAppSender | null } {
  return {
    email: env.RESEND_API_KEY && env.EMAIL_FROM ? createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, replyTo: env.EMAIL_REPLY_TO }) : null,
    whatsapp:
      env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
        ? createWhatsAppSender({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION })
        : null,
  };
}

/** Which channels can send right now (for the staff screens). */
export function channelStatus(env: NodeJS.ProcessEnv = process.env) {
  return { email: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM), whatsapp: Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) };
}
