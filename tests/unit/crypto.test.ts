import { describe, expect, it, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { _resetKeyCache, decryptSecret, encryptJson, decryptJson, encryptSecret, generateEncryptionKey, safeEqual } from "@/lib/crypto/secrets";

describe("credential encryption", () => {
  beforeEach(() => _resetKeyCache());

  it("round-trips and never reuses an IV", () => {
    const a = encryptSecret("token-a");
    const b = encryptSecret("token-a");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptSecret(a)).toBe("token-a");
    expect(decryptSecret(b)).toBe("token-a");
    expect(a.version).toBe(1);
  });

  it("detects tampering", () => {
    const rec = encryptSecret("sensitive");
    const tampered = { ...rec, ciphertext: Buffer.from(Buffer.from(rec.ciphertext, "base64").map((x, i) => (i === 0 ? x ^ 1 : x))).toString("base64") };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("binds ciphertext to its AAD (connection id)", () => {
    const rec = encryptJson({ kind: "api_key", key: "abc" }, "conn-1");
    expect(decryptJson(rec, "conn-1")).toEqual({ kind: "api_key", key: "abc" });
    expect(() => decryptJson(rec, "conn-2")).toThrow();
  });

  it("rejects a malformed key", () => {
    const prev = process.env.JEFF_CREDENTIAL_ENCRYPTION_KEY;
    process.env.JEFF_CREDENTIAL_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    _resetKeyCache();
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    process.env.JEFF_CREDENTIAL_ENCRYPTION_KEY = prev;
    _resetKeyCache();
  });

  it("generates valid keys", () => {
    expect(Buffer.from(generateEncryptionKey(), "base64").length).toBe(32);
  });

  it("safeEqual is length-safe", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
