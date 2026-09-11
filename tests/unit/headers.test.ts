import { describe, expect, it } from "vitest";
import { buildCsp, STATIC_SECURITY_HEADERS } from "@/lib/security/headers";

describe("security headers", () => {
  it("CSP is nonce-based with strict-dynamic and no unsafe-inline scripts", () => {
    const csp = buildCsp({ nonce: "abc123", supabaseUrl: "https://example.supabase.co" });
    const script = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("connect-src 'self' https://example.supabase.co wss://example.supabase.co");
    expect(csp).toContain("upgrade-insecure-requests");
  });
  it("dev mode adds unsafe-eval for HMR only", () => {
    expect(buildCsp({ nonce: "n", dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp({ nonce: "n", dev: true })).not.toContain("upgrade-insecure-requests");
  });
  it("static headers include clickjacking, sniffing, referrer and HSTS", () => {
    const keys = STATIC_SECURITY_HEADERS.map((h) => h.key);
    expect(keys).toEqual(expect.arrayContaining(["X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security"]));
    expect(STATIC_SECURITY_HEADERS.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
  });
});
