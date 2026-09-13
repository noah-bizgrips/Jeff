import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getSettings } from "@/lib/jeff/settings-store";
import { interpretReminder, toObligationInput } from "@/lib/jeff/obligations/interpret";
import { countBuckets, createObligation, listObligations } from "@/lib/jeff/obligations/store";
import { ObligationInputSchema, bucketOf } from "@/lib/jeff/obligations/types";
import { looksSensitive } from "@/lib/security/redact";

export const dynamic = "force-dynamic";

/** GET /api/obligations?view=live|done — the Follow-Through queue with bucket counts. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const view = url.searchParams.get("view") === "done" ? "done" : "live";
  const now = new Date();
  const rows = view === "done" ? await listObligations(g.session.userId, { statuses: ["completed", "dismissed", "cancelled"], limit: 100 }) : await listObligations(g.session.userId, { live: true, limit: 300 });
  const live = view === "done" ? await listObligations(g.session.userId, { live: true, limit: 300 }) : rows;
  return json({ counts: countBuckets(live, now), obligations: rows.map((o) => ({ ...o, bucket: bucketOf(o, now) })) });
});

const Create = z.union([
  z.object({ text: z.string().trim().min(3).max(1000), scope: z.enum(["business", "personal", "financial"]).optional(), tracking_mode: z.enum(["once", "persistent", "important", "critical"]).optional() }).strict(),
  ObligationInputSchema,
]);

/** POST /api/obligations — natural-language reminder ({text}) or a structured obligation. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Create);
  if (!body.ok) return body.response;
  const now = new Date();
  if ("text" in body.data) {
    if (looksSensitive(body.data.text)) return apiError("sensitive_content_rejected", 400);
    const settings = await getSettings(g.session.userId);
    const interp = interpretReminder(body.data.text, now, settings.timezone);
    if (body.data.scope) interp.scope = body.data.scope;
    if (body.data.tracking_mode) interp.tracking_mode = body.data.tracking_mode;
    const { row, created } = await createObligation(g.session.userId, toObligationInput(interp, "jeff"), { actor: "owner", now });
    return json({ obligation: { ...row, bucket: bucketOf(row, now) }, created, interpretation: interp }, { status: created ? 201 : 200 });
  }
  if (looksSensitive(`${body.data.title} ${body.data.description ?? ""}`)) return apiError("sensitive_content_rejected", 400);
  const { row, created } = await createObligation(g.session.userId, body.data, { actor: "owner", now });
  return json({ obligation: { ...row, bucket: bucketOf(row, now) }, created }, { status: created ? 201 : 200 });
});
