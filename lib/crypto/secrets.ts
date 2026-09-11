import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Application-layer encryption for integration credentials.
 *
 * AES-256-GCM with a fresh 96-bit random IV per encryption. The stored record
 * carries ciphertext, iv, auth tag and a version so the scheme can be rotated
 * without a destructive migration.
 *
 * This module is server-only: importing it from a client component fails at
 * build time via the `server-only` package guard.
 */

export const ENCRYPTION_VERSION = 1;
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedSecret {
  version: number;
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
}

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.JEFF_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error("JEFF_CREDENTIAL_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("JEFF_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)");
  }
  cachedKey = key;
  return key;
}

/** Allows tests to clear the cached key after changing the env. */
export function _resetKeyCache() {
  cachedKey = null;
}

export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * @param plaintext  UTF-8 string (usually a JSON credential bundle)
 * @param aad        Optional additional authenticated data (e.g. connection id)
 *                   binding the ciphertext to its row.
 */
export function encryptSecret(plaintext: string, aad?: string): EncryptedSecret {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: ENCRYPTION_VERSION,
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(record: EncryptedSecret, aad?: string): string {
  if (record.version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version ${record.version}`);
  }
  const key = loadKey();
  const iv = Buffer.from(record.iv, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  const decipher = createDecipheriv(ALGO, key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

export function encryptJson(value: unknown, aad?: string): EncryptedSecret {
  return encryptSecret(JSON.stringify(value), aad);
}

export function decryptJson<T = unknown>(record: EncryptedSecret, aad?: string): T {
  return JSON.parse(decryptSecret(record, aad)) as T;
}

/** Constant-time string comparison for tokens/signatures. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
