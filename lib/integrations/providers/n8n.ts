import "server-only";
import type { TestResult } from "./base";
import { fetchJson } from "./base";
import { hasEnv, requireEnv } from "@/lib/env";

/**
 * n8n adapter. The API key lives only in Vercel env (N8N_API_KEY) and is
 * used exclusively inside this module. Claude tools call these narrow
 * functions; they never see the key.
 *
 * V1 rules: read anything; write ONLY to workflows tagged `gomez-test`.
 * Production workflow changes are refused here regardless of caller.
 */
const TEST_TAG = "gomez-test";

function base() {
  return requireEnv("N8N_BASE_URL").replace(/\/$/, "");
}

function headers() {
  return { "X-N8N-API-KEY": requireEnv("N8N_API_KEY"), Accept: "application/json" };
}

export function n8nConfigured() {
  return hasEnv("N8N_BASE_URL") && hasEnv("N8N_API_KEY");
}

export async function testN8n(): Promise<TestResult> {
  if (!n8nConfigured()) return { ok: false, error: "n8n_not_configured" };
  const { status } = await fetchJson<{ data?: unknown[] }>(`${base()}/api/v1/workflows?limit=1`, { headers: headers() });
  if (status !== 200) return { ok: false, error: `n8n_workflows_failed:${status}` };
  let host = "n8n";
  try {
    host = new URL(base()).host;
  } catch {
    /* ignore */
  }
  return { ok: true, accountIdentifier: host, details: { reachable: true } };
}

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  tags: string[];
  updatedAt?: string;
  isTest: boolean;
}

export async function listWorkflows(): Promise<N8nWorkflowSummary[]> {
  const { status, body } = await fetchJson<{ data?: { id: string; name: string; active: boolean; tags?: { name: string }[]; updatedAt?: string }[] }>(
    `${base()}/api/v1/workflows?limit=100`,
    { headers: headers() },
  );
  if (status !== 200) throw new Error(`n8n_list_failed:${status}`);
  return (body?.data ?? []).map((w) => {
    const tags = (w.tags ?? []).map((t) => t.name);
    return { id: w.id, name: w.name, active: w.active, tags, updatedAt: w.updatedAt, isTest: tags.includes(TEST_TAG) };
  });
}

export async function listExecutions(workflowId?: string, limit = 20) {
  const u = new URL(`${base()}/api/v1/executions`);
  u.searchParams.set("limit", String(Math.min(limit, 100)));
  if (workflowId) u.searchParams.set("workflowId", workflowId);
  const { status, body } = await fetchJson<{ data?: { id: string; status?: string; startedAt?: string; stoppedAt?: string; workflowId?: string }[] }>(
    u.toString(),
    { headers: headers() },
  );
  if (status !== 200) throw new Error(`n8n_executions_failed:${status}`);
  return (body?.data ?? []).map((e) => ({ id: e.id, status: e.status, startedAt: e.startedAt, stoppedAt: e.stoppedAt, workflowId: e.workflowId }));
}

/** Guard used by any write path: only `gomez-test` tagged workflows may be modified in V1. */
export async function assertTestWorkflow(workflowId: string) {
  const all = await listWorkflows();
  const w = all.find((x) => x.id === workflowId);
  if (!w) throw new Error("n8n_workflow_not_found");
  if (!w.isTest) throw new Error("n8n_production_write_refused");
  return w;
}
