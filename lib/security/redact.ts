/**
 * Secret redaction for logs, audit metadata and error messages.
 * Heuristic: it is a backstop, not a guarantee. Never log raw request bodies.
 */

const PATTERNS: RegExp[] = [
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe keys
  /whsec_[A-Za-z0-9]{10,}/g, // Stripe webhook secrets
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprse]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /ntn_[A-Za-z0-9]{20,}/g, // Notion tokens
  /secret_[A-Za-z0-9]{20,}/g, // Notion legacy
  /access-(?:sandbox|development|production)-[0-9a-f-]{20,}/g, // Plaid access tokens
  /public-(?:sandbox|development|production)-[0-9a-f-]{20,}/g, // Plaid public tokens
  /link-(?:sandbox|development|production)-[0-9a-f-]{20,}/g, // Plaid link tokens
  /ya29\.[A-Za-z0-9_-]{20,}/g, // Google access tokens
  /1\/\/[A-Za-z0-9_-]{20,}/g, // Google refresh tokens
  /EAA[A-Za-z0-9]{20,}/g, // Meta tokens
  /sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g, // Supabase keys
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(Basic\s+)[A-Za-z0-9+/=]{12,}/gi,
  /https?:\/\/[^\s/:@]+:[^\s@]+@/g, // basic-auth in URLs
  /([?&#](?:token|key|secret|signature|access_token|refresh_token|client_secret|code|state|api_key|apikey)=)[^\s&#]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|authorization|totp|otp)\s*[:=]\s*["']?)[^\s"',]{6,}/gi,
];

const SENSITIVE_KEYS = /(secret|token|password|passwd|key|authorization|cookie|credential|totp|otp|signature|private)/i;

export function redactString(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      const prefix = typeof groups[0] === "string" && match.startsWith(groups[0]) ? groups[0] : "";
      return `${prefix}[REDACTED]`;
    });
  }
  return out;
}

/**
 * Deep-redacts an object for logging. Keys that look sensitive are replaced
 * wholesale; string values are pattern-scrubbed.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[depth-limit]" as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function looksSensitive(text: string): boolean {
  return PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
