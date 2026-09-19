import { vi } from "vitest";

export const OWNER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_ID = "22222222-2222-4222-8222-222222222222";

export type Claims = { sub: string; email: string; aal: "aal1" | "aal2" } | null;

/** Builds a fake Supabase server client whose getClaims returns the given claims. */
export function fakeSupabase(claims: Claims, extra: Record<string, unknown> = {}) {
  return {
    auth: {
      getClaims: vi.fn(async () => ({ data: claims ? { claims } : null, error: claims ? null : { message: "no session" } })),
      ...((extra.auth as object) ?? {}),
    },
    from: vi.fn(() => chain()),
    ...extra,
  };
}

/** Minimal chainable query builder returning empty results. */
export function chain(result: unknown = { data: [], error: null, count: 0 }) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  for (const m of ["select", "eq", "in", "gte", "lte", "order", "limit", "insert", "update", "delete", "upsert", "textSearch"]) c[m] = vi.fn(self);
  c.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  c.single = vi.fn(async () => ({ data: null, error: null }));
  c.then = (resolve: (v: unknown) => void) => resolve(result);
  return c;
}

export function req(path: string, init: RequestInit & { origin?: string | null; sameOrigin?: boolean } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.sameOrigin !== false) headers.set("sec-fetch-site", "same-origin");
  if (init.origin) headers.set("origin", init.origin);
  return new Request(`https://jeff.test${path}`, { ...init, headers });
}

export function jsonReq(path: string, body: unknown, init: Parameters<typeof req>[1] = {}) {
  return req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...init });
}
