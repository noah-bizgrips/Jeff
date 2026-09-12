import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { getSettings, updateSettings } from "@/lib/jeff/settings-store";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  return json({ settings: await getSettings(g.session.userId) });
});

/** PATCH /api/settings — Tier 1 preferences only (the schema is the allow-list; unknown keys are rejected). */
export const PATCH = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError("invalid_json", 400);
  }
  const res = await updateSettings(g.session.userId, raw);
  if (!res.ok) return apiError("invalid_input", 400, { reason: res.reason });
  await audit({ event: "settings_updated", ownerId: g.session.userId, request: req, metadata: { changed: res.changed } });
  return json({ settings: res.settings, changed: res.changed });
});
