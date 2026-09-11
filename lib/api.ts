import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { errorMessage, log } from "@/lib/security/log";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, init?: { status?: number }) {
  return NextResponse.json(data, { status: init?.status ?? 200, headers: NO_STORE });
}

export function apiError(code: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: code, ...(extra ?? {}) }, { status, headers: NO_STORE });
}

/** Parses and validates a JSON body. Never echoes the body back on failure. */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: apiError("invalid_json", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: apiError("invalid_input", 400, { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Wraps a handler so unexpected errors become redacted 500s. */
export function withErrorBoundary(handler: (req: Request, ctx: RouteContext) => Promise<Response>) {
  return async (req: Request, ctx: RouteContext) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      log.error("api_unhandled", { path: new URL(req.url).pathname, message: errorMessage(err) });
      return apiError("internal_error", 500);
    }
  };
}

export type RouteContext = { params: Promise<Record<string, string>> };
