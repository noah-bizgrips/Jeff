import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { recordAttention } from "@/lib/jeff/attention/store";
import { ATTENTION_KINDS } from "@/lib/jeff/attention/types";

export const dynamic = "force-dynamic";

const Body = z.object({
  signals: z
    .array(
      z.object({
        kind: z.enum(ATTENTION_KINDS),
        ref_id: z.string().max(120).nullable().optional(),
        path: z.string().max(200).regex(/^\/\S*$/, "path must be a relative path").nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * POST /api/attention — owner + aal2. Batched "the owner looked at X"
 * signals. `sendBeacon` may send a Blob without a JSON content type, so the
 * body is parsed from text rather than through parseBody.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  let raw: unknown;
  try {
    raw = JSON.parse(await req.text());
  } catch {
    return apiError("invalid_json", 400);
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return apiError("invalid_input", 400);
  const recorded = await recordAttention(g.session.userId, parsed.data.signals);
  return json({ ok: true, recorded });
});
