import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Payment providers. The app creates a pending payment, sends the guest to
 * the provider's page, and learns the result from a server-to-server
 * notification (webhook) or, for the simulator, from its own page.
 *
 * Which provider runs: Xendit when XENDIT_SECRET_KEY is set, otherwise the
 * simulator, which never moves money and labels itself clearly.
 */

export type CheckoutRequest = {
  amount: number;
  currency: string;
  description: string;
  customer: { name: string; email: string; phone?: string | null };
  /** Where the provider sends the guest afterwards. */
  successUrl: string;
  failureUrl: string;
  expiresAt: Date;
  locale: "id" | "en";
};

export type CheckoutSession = { providerRef: string; checkoutUrl: string; expiresAt: Date };

export interface PaymentProvider {
  readonly name: "simulated" | "xendit";
  createCheckout(request: CheckoutRequest, appUrl: string): Promise<CheckoutSession>;
}

const simulated: PaymentProvider = {
  name: "simulated",
  async createCheckout(request, appUrl) {
    const providerRef = `sim_${randomBytes(12).toString("base64url")}`;
    return {
      providerRef,
      checkoutUrl: new URL(`/${request.locale}/pay/simulated/${providerRef}`, appUrl).toString(),
      expiresAt: request.expiresAt,
    };
  },
};

/**
 * Xendit hosted invoice (POST /v2/invoices, Basic auth with the secret key).
 * Not yet exercised against Xendit's test mode: verify with test keys before
 * taking real payments.
 */
function xendit(secretKey: string): PaymentProvider {
  return {
    name: "xendit",
    async createCheckout(request) {
      const externalId = `pay_${randomBytes(12).toString("base64url")}`;
      const seconds = Math.max(60, Math.floor((request.expiresAt.getTime() - Date.now()) / 1000));
      const response = await fetch("https://api.xendit.co/v2/invoices", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          external_id: externalId,
          amount: request.amount,
          currency: request.currency,
          description: request.description,
          invoice_duration: seconds,
          payer_email: request.customer.email,
          customer: {
            given_names: request.customer.name,
            email: request.customer.email,
            mobile_number: request.customer.phone || undefined,
          },
          success_redirect_url: request.successUrl,
          failure_redirect_url: request.failureUrl,
          locale: request.locale,
        }),
      });
      if (!response.ok) {
        throw new Error(`Xendit invoice failed: HTTP ${response.status}`);
      }
      const invoice = (await response.json()) as { invoice_url: string; expiry_date?: string };
      return {
        providerRef: externalId,
        checkoutUrl: invoice.invoice_url,
        expiresAt: invoice.expiry_date ? new Date(invoice.expiry_date) : request.expiresAt,
      };
    },
  };
}

export function getPaymentProvider(): PaymentProvider {
  const key = process.env.XENDIT_SECRET_KEY;
  return key ? xendit(key) : simulated;
}

export function simulatorEnabled(): boolean {
  return !process.env.XENDIT_SECRET_KEY;
}

/** Constant-time comparison of the webhook's x-callback-token. */
export function verifyXenditCallbackToken(received: string | null): boolean {
  const expected = process.env.XENDIT_CALLBACK_TOKEN;
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
