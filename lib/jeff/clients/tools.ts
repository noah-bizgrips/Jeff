import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadClientMap, type ClientMapEntry } from "./map";
import { summarizeClients, type ClientRow } from "./overview";
import { recordAttention } from "@/lib/jeff/attention/store";

/**
 * Ask Jeff tools for the client roster. Everything is derived from the portal
 * (source of truth) plus attributed Stripe/HighLevel/Meta rows. No raw emails
 * or phones ever appear — the portal exports hashes and last-4 only.
 */
export interface ClientToolContext {
  ownerId: string;
}

export const CLIENT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_clients",
    description:
      "Client roster from the BizGrips portal: status, stage progress, overdue task counts by owner, new/uncontacted leads, and — where attributed — unpaid invoices and 7-day ad spend. Use for 'how are my clients doing', 'which clients are behind', 'who owes us'.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["active_setup", "delivery", "paused", "churned", "all"] }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: "get_client_overview",
    description: "One client in depth by name or slug: stages, overdue and upcoming tasks, recent leads and appointments, notification problems, attributed invoices/ad spend, and open findings. Evidence-linked to the portal admin page.",
    input_schema: { type: "object", properties: { client: { type: "string", description: "Client name or slug (fuzzy)" } }, required: ["client"], additionalProperties: false },
  },
];

const RESOURCE_TYPES = ["client", "stage", "task", "lead", "appointment", "notification", "invoice", "charge", "ad_insight", "opportunity"];

async function loadRows(ownerId: string): Promise<ClientRow[]> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("source_items")
    .select("id, provider, resource_type, external_id, title, summary, source_url, source_timestamp, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .in("resource_type", RESOURCE_TYPES)
    .or(`source_timestamp.gte.${since},source_timestamp.is.null`)
    .limit(6000);
  if (error) throw new Error(`client_rows_failed:${error.code ?? ""}`);
  return (data ?? []) as ClientRow[];
}

function findClient(map: ClientMapEntry[], query: string): ClientMapEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    map.find((c) => c.slug === q || c.name.toLowerCase() === q) ??
    map.find((c) => c.name.toLowerCase().includes(q) || (c.slug ?? "").includes(q.replace(/\s+/g, "-"))) ??
    null
  );
}

export async function runClientTool(name: string, input: Record<string, unknown>, ctx: ClientToolContext): Promise<unknown | undefined> {
  if (name !== "list_clients" && name !== "get_client_overview") return undefined;
  const map = await loadClientMap(ctx.ownerId);
  if (!map.length) return { note: "No portal clients synced yet. Connect the BizGrips Client Portal and Sync now." };
  const rows = await loadRows(ctx.ownerId);
  const admin = createAdminClient();
  const { data: findings } = await admin
    .from("findings")
    .select("id, category, title, severity, status, evidence, metrics")
    .eq("owner_id", ctx.ownerId)
    .in("status", ["new", "open", "reviewing", "accepted", "monitoring"])
    .limit(300);
  const summaries = summarizeClients(map, rows, (findings ?? []) as { id: string; category: string; title: string; severity: string; status: string; evidence: unknown; metrics: Record<string, unknown> }[], new Date());

  if (name === "list_clients") {
    const status = typeof input.status === "string" && input.status !== "all" ? input.status : null;
    const limit = Math.min(Number(input.limit ?? 25), 50);
    const list = summaries.filter((c) => !status || c.status === status).slice(0, limit);
    return {
      count: list.length,
      clients: list.map((c) => {
        const compact: Partial<typeof c> = { ...c };
        delete compact.recent_leads;
        delete compact.tasks_overdue_list;
        return compact;
      }),
    };
  }
  const hit = findClient(map, String(input.client ?? ""));
  if (!hit) return { error: "client_not_found", known: map.map((c) => c.name).slice(0, 30) };
  // Looking at a client through chat counts as attention (blind-spot detection).
  void recordAttention(ctx.ownerId, [{ kind: "client_viewed", ref_id: hit.portal_client_id }]);
  return summaries.find((c) => c.client_id === hit.portal_client_id) ?? { error: "client_not_found" };
}
