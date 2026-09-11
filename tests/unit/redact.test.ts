import { describe, expect, it } from "vitest";
import { looksSensitive, redact, redactString } from "@/lib/security/redact";

// Synthetic, non-functional samples in the SHAPE of real tokens.
const SAMPLES = [
  "sk-ant-api03-" + "A".repeat(40),
  "sk-proj-" + "b".repeat(32),
  "rk_live_" + "c".repeat(24),
  "sk_test_" + "d".repeat(24),
  "whsec_" + "e".repeat(32),
  "ghp_" + "f".repeat(36),
  "github_pat_" + "g".repeat(40),
  "xoxb-" + "1234567890-" + "h".repeat(24),
  "xoxp-" + "1234567890-" + "h".repeat(24),
  "ntn_" + "i".repeat(40),
  "access-sandbox-" + "0123456789abcdef-0123-4567-89ab-cdef01234567",
  "public-production-" + "0123456789abcdef-0123-4567-89ab-cdef01234567",
  "ya29." + "j".repeat(60),
  "EAA" + "k".repeat(80),
  "sb_secret_" + "l".repeat(30),
  "eyJhbGciOiJIUzI1NiJ9." + "m".repeat(40) + "." + "n".repeat(43),
];

describe("secret redaction", () => {
  it.each(SAMPLES)("scrubs %s", (sample) => {
    const out = redactString(`prefix ${sample} suffix`);
    expect(out).not.toContain(sample);
    expect(out).toContain("[REDACTED]");
    expect(looksSensitive(sample)).toBe(true);
  });

  it("scrubs bearer headers, basic-auth URLs and query tokens", () => {
    expect(redactString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(redactString("https://user:hunter2hunter2@example.com/x")).not.toContain("hunter2");
    expect(redactString("https://x.test/cb?code=abcdef123456&state=zzz")).not.toContain("abcdef123456");
  });

  it("scrubs key=value assignments", () => {
    expect(redactString('client_secret="supersecretvalue123"')).not.toContain("supersecretvalue123");
    expect(redactString("password: hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  it("deep-redacts objects by key and value", () => {
    const out = redact({ access_token: "plain", nested: { note: "token ghp_" + "z".repeat(36) }, safe: "hello" });
    expect(out).toEqual({ access_token: "[REDACTED]", nested: { note: "token [REDACTED]" }, safe: "hello" });
  });

  it("leaves ordinary text alone", () => {
    const text = "Follow up with Sam about the $8,400 estimate on September 10.";
    expect(redactString(text)).toBe(text);
    expect(looksSensitive(text)).toBe(false);
  });

  it("private keys are removed wholesale", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    expect(redactString(pem)).toBe("[REDACTED]");
  });
});
