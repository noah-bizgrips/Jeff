/**
 * Content Security Policy for the real Next.js app (the standalone HTML CSP
 * no longer applies).
 *
 * - script-src is nonce-based with 'strict-dynamic'. No 'unsafe-inline'.
 * - style-src keeps 'unsafe-inline' deliberately: React sets per-element
 *   inline `style` attributes (graph anchor positions, source colours) and
 *   Next.js emits inline style tags for streaming. Attribute styles cannot be
 *   nonced. Inline styles cannot exfiltrate data on their own; scripts are the
 *   controlled surface.
 * - connect-src is limited to same-origin plus the Supabase project.
 * - Plaid Link is allowed only as a nonced script + its iframe origin.
 */
export function buildCsp(opts: { nonce: string; supabaseUrl?: string; dev?: boolean }): string {
  const supabase = safeOrigin(opts.supabaseUrl);
  const supabaseWs = supabase ? supabase.replace(/^https:/, "wss:") : "";
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${opts.nonce}'`, "'strict-dynamic'", ...(opts.dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(supabase ? [supabase, supabaseWs] : [])],
    "frame-src": ["https://cdn.plaid.com"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    ...(opts.dev ? {} : { "upgrade-insecure-requests": [] }),
  };
  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}

function safeOrigin(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Static headers applied to every response (see next.config.ts). */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];
