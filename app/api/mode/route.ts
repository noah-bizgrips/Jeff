import { z } from "zod";
import { cookies } from "next/headers";
import { json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/** POST /api/mode — explicit Demo/Live switch, stored in an HttpOnly cookie. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, z.object({ mode: z.enum(["demo", "live"]) }));
  if (!body.ok) return body.response;
  const store = await cookies();
  store.set("gomez_mode", body.data.mode, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return json({ ok: true, mode: body.data.mode });
});
