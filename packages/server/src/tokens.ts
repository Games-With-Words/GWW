/**
 * Join tokens and short codes (spec §11 required safeguards).
 * Tokens are stored ONLY as sha256 hashes (spec §10 data minimization).
 */

import { createHash, randomBytes } from "node:crypto";

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Human-readable fallback code: 6 chars, no ambiguous glyphs (0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newShortCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}
