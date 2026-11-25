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
  customer: { name: string; email?: string | null; phone?: string | null };
  /** Where the provider sends the guest afterwards. */
  successUrl: string;
  failureUrl: string;
  expiresAt: Date;
  locale: "id" | "en";
};

export type CheckoutSession = { providerRef: string; checkoutUrl: string; expiresAt: Date };

/** A checkout as the provider reports it, read from the provider itself. */
export type CheckoutState = { status: "pending" | "paid" | "expired" | "cancelled"; amount: number | null; currency: string | null };

export interface PaymentProvider {
  readonly name: "simulated" | "xendit";
  createCheckout(request: CheckoutRequest, appUrl: string): Promise<CheckoutSession>;
  /** Makes an open checkout unusable (best effort; a checkout already closed is fine). */
  cancelCheckout(providerRef: string): Promise<void>;
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
  async cancelCheckout() {
    // The simulator reads the payment's status from the database.
  },
};

export class XenditError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "XenditError";
  }
}

type Fetch = typeof fetch;

const XENDIT_API = "https://api.xendit.co";

/**
 * Xendit Payment Sessions with a Xendit-hosted payment page
 * (POST /sessions, session_type PAY, mode PAYMENT_LINK). Xendit's older
 * Invoice API is documented as legacy; Sessions replace it.
 * The session id (ps-...) is our provider reference.
 */
export function createXenditProvider(secretKey: string, fetchImpl: Fetch = fetch) {
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${XENDIT_API}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Not JSON; reported below by status.
    }
    if (!response.ok) {
      const code = typeof json.error_code === "string" ? json.error_code : null;
      const message = typeof json.message === "string" ? json.message : `HTTP ${response.status}`;
      throw new XenditError(response.status, code, `Xendit ${method} ${path} failed: ${code ?? response.status} ${message}`);
    }
    return json as T;
  }

  type Session = {
    payment_session_id: string;
    status: "ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELED";
    payment_link_url: string | null;
    expires_at?: string;
    amount?: number;
    currency?: string;
  };

  const statusOf: Record<Session["status"], CheckoutState["status"]> = {
    ACTIVE: "pending",
    COMPLETED: "paid",
    EXPIRED: "expired",
    CANCELED: "cancelled",
  };

  return {
    name: "xendit" as const,

    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const session = await call<Session>("POST", "/sessions", {
        reference_id: `pay_${randomBytes(12).toString("base64url")}`,
        session_type: "PAY",
        mode: "PAYMENT_LINK",
        amount: request.amount,
        currency: request.currency,
        country: "ID",
        description: request.description.slice(0, 1000),
        success_return_url: request.successUrl,
        cancel_return_url: request.failureUrl,
        expires_at: request.expiresAt.toISOString(),
      });
      if (!session.payment_session_id || !session.payment_link_url) {
        throw new XenditError(502, null, "Xendit session response has no id or payment link");
      }
      return {
        providerRef: session.payment_session_id,
        checkoutUrl: session.payment_link_url,
        expiresAt: session.expires_at ? new Date(session.expires_at) : request.expiresAt,
      };
    },

    async cancelCheckout(providerRef: string): Promise<void> {
      try {
        await call("POST", `/sessions/${encodeURIComponent(providerRef)}/cancel`);
      } catch (error) {
        // Already completed, expired or cancelled: nothing left to close.
        if (error instanceof XenditError && (error.httpStatus === 422 || error.httpStatus === 404)) return;
        throw error;
      }
    },

    /** The session as Xendit has it now; the webhook trusts this, not its own body. */
    async getCheckout(providerRef: string): Promise<CheckoutState> {
      const session = await call<Session>("GET", `/sessions/${encodeURIComponent(providerRef)}`);
      return {
        status: statusOf[session.status] ?? "pending",
        amount: typeof session.amount === "number" ? session.amount : null,
        currency: session.currency ?? null,
      };
    },
  };
}

export type XenditProvider = ReturnType<typeof createXenditProvider>;

export function xenditProvider(): XenditProvider | null {
  const key = process.env.XENDIT_SECRET_KEY;
  return key ? createXenditProvider(key) : null;
}

export function getPaymentProvider(): PaymentProvider {
  return xenditProvider() ?? simulated;
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
