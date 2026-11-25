import "server-only";
import { getDb } from "@/db/client";
import { createAuth, type Auth } from "./config";

let auth: Auth | undefined;

/** Lazily created so builds and pages that never authenticate need no secrets. */
export function getAuth(): Auth {
  if (auth) return auth;
  const baseURL = process.env.BETTER_AUTH_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!baseURL || !secret) {
    throw new Error("BETTER_AUTH_URL and BETTER_AUTH_SECRET must be set. See .env.example.");
  }
  auth = createAuth(getDb(), { baseURL, secret });
  return auth;
}
