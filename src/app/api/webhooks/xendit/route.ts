import { getDb } from "@/db/client";
import { verifyXenditCallbackToken, xenditProvider } from "@/lib/payments/provider";
import { deliverSoon } from "@/lib/notifications/deliver";
import { processXenditSessionEvent } from "@/lib/payments/xendit-webhook";

/**
 * Xendit webhook for Payment Sessions. Set this URL in the Xendit Dashboard
 * webhook settings. The callback token (x-callback-token) proves the call
 * comes from our Xendit account; the payment itself is then confirmed by
 * reading the session back from Xendit's API.
 */
export async function POST(request: Request) {
  if (!verifyXenditCallbackToken(request.headers.get("x-callback-token"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const xendit = xenditProvider();
  if (!xendit) return new Response("xendit not configured", { status: 503 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const result = await processXenditSessionEvent(getDb(), xendit, payload);
  deliverSoon();
  return Response.json(result.body, { status: result.status });
}
