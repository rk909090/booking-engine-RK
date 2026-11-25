import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/*
 * Encryption of guests' identity document numbers (AES-256-GCM).
 *
 * Key: GUEST_DATA_KEY (32 random bytes, base64) when it is set. Until then a
 * key is derived from BETTER_AUTH_SECRET, so the feature works without a new
 * setting. Each value records which key sealed it ("g" or "a"), so setting
 * GUEST_DATA_KEY later keeps older values readable. Rotating
 * BETTER_AUTH_SECRET makes "a" values unreadable; they are erased 30 days
 * after check-out anyway.
 *
 * Format: v1.<key>.<iv>.<tag>.<ciphertext>, parts base64url.
 */

function keyFor(id: "g" | "a"): Buffer {
  if (id === "g") {
    const raw = process.env.GUEST_DATA_KEY;
    if (!raw) throw new Error("GUEST_DATA_KEY is not set");
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("GUEST_DATA_KEY must be 32 bytes, base64-encoded");
    return key;
  }
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  return Buffer.from(hkdfSync("sha256", secret, "attara-guest-data", "document-numbers", 32));
}

export function sealGuestData(plain: string): string {
  const id = process.env.GUEST_DATA_KEY ? "g" : "a";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(id), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** The plain value, or null when it cannot be read (wrong key, tampered, unknown format). */
export function openGuestData(sealed: string): string | null {
  const [version, id, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || (id !== "g" && id !== "a") || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(id), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
