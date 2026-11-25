import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Guest booking links: /booking/<code>?t=<token>. The token is an HMAC of the
 * booking code, so the link proves the holder received it (by email or right
 * after booking) without putting the guest's email in the URL.
 */

function secret(): string {
  const value = process.env.BOOKING_LINK_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("Set BOOKING_LINK_SECRET or BETTER_AUTH_SECRET.");
  return value;
}

export function bookingAccessToken(code: string): string {
  return createHmac("sha256", secret()).update(`booking:${code}`).digest("base64url").slice(0, 32);
}

export function verifyBookingAccessToken(code: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(bookingAccessToken(code));
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function appUrl(): string {
  return process.env.APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}
