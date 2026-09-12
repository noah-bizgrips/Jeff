import "server-only";
import type Stripe from "stripe";
import { stripeClient, type StripeSecret } from "@/lib/integrations/providers/stripe";
import { readSecret } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { redactString } from "@/lib/security/redact";
import {
  mapBalanceTransaction,
  mapCharge,
  mapCustomer,
  mapDispute,
  mapInvoice,
  mapPayout,
  mapRefund,
  mapSubscription,
} from "./stripe-mappers";
import type { SourceItemInput } from "./types";
import type { CapabilityFetch, SyncAdapter } from "./runner";

/**
 * Stripe read-only reporting sync using the owner's RESTRICTED key.
 *
 * - `list` calls only (no writes exist on this adapter).
 * - Incremental by `created >= cursor`; cursor = newest `created` seen.
 * - Capped at MAX_PER_RESOURCE objects per resource per run.
 * - Resources whose probe failed during the connection test
 *   (metadata.last_test_details[resource] === false) are skipped cleanly.
 *
 * The connection's single capability is "reporting"; every Stripe resource
 * is fetched under it and written with a distinct resource_type.
 */

const PAGE = 100;
const MAX_PER_RESOURCE = 500;
const INITIAL_WINDOW_DAYS = 90;
const DAY = 86_400_000;

async function clientFor(conn: ConnectionSummary): Promise<Stripe> {
  const secret = await readSecret<StripeSecret>(conn.id);
  if (!secret || secret.kind !== "api_key") throw new Error("secret_missing");
  return stripeClient(secret);
}

/** Stripe errors may carry request ids and our key prefix; keep only type/code. */
function safeError(err: unknown, resource: string): Error {
  const e = err as { type?: string; code?: string; statusCode?: number; message?: string };
  const code = e?.code ?? e?.type ?? "unknown";
  const status = e?.statusCode ?? "";
  return new Error(`stripe_${resource}_failed:${status}:${redactString(String(code)).slice(0, 60)}`);
}

function sinceFrom(cursor: string | null): number {
  const parsed = cursor ? Number(cursor) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return Math.floor((Date.now() - INITIAL_WINDOW_DAYS * DAY) / 1000);
}

function probeFailed(conn: ConnectionSummary, probe: string): boolean {
  const details = conn.metadata.last_test_details;
  return !!details && typeof details === "object" && (details as Record<string, unknown>)[probe] === false;
}

/**
 * Generic bounded list walker over a Stripe auto-paginating list. Returns the
 * objects (newest first as Stripe returns them) and the max `created` seen.
 */
async function walk<T extends { created: number }>(
  list: () => Stripe.ApiListPromise<T>,
  resource: string,
): Promise<{ objects: T[]; maxCreated: number | null; seen: number }> {
  const objects: T[] = [];
  let maxCreated: number | null = null;
  try {
    for await (const obj of list()) {
      objects.push(obj);
      if (maxCreated === null || obj.created > maxCreated) maxCreated = obj.created;
      if (objects.length >= MAX_PER_RESOURCE) break;
    }
  } catch (err) {
    throw safeError(err, resource);
  }
  return { objects, maxCreated, seen: objects.length };
}

/** A cursor that never goes backwards and (when nothing new) stays put. */
export function nextCursor(prev: string | null, maxCreated: number | null): string | null {
  const before = prev && Number.isFinite(Number(prev)) ? Number(prev) : 0;
  const next = Math.max(before, maxCreated ?? 0);
  return next > 0 ? String(next) : prev;
}

type Resource = {
  key: string;
  probe: string;
  fetch: (stripe: Stripe, since: number) => Stripe.ApiListPromise<{ created: number }>;
  map: (obj: unknown) => SourceItemInput | null;
};

const RESOURCES: Resource[] = [
  {
    key: "charges",
    probe: "charges",
    fetch: (s, since) => s.charges.list({ limit: PAGE, created: { gte: since } }),
    map: (o) => mapCharge(o as unknown as Parameters<typeof mapCharge>[0]),
  },
  {
    key: "invoices",
    probe: "invoices",
    fetch: (s, since) => s.invoices.list({ limit: PAGE, created: { gte: since } }),
    map: (o) => mapInvoice(o as unknown as Parameters<typeof mapInvoice>[0]),
  },
  {
    key: "subscriptions",
    probe: "subscriptions",
    // Subscriptions are few and mutate in place: always fetch all statuses (no created filter) so status changes are captured.
    fetch: (s) => s.subscriptions.list({ limit: PAGE, status: "all", expand: ["data.items.data.price.product"] }),
    map: (o) => mapSubscription(o as unknown as Parameters<typeof mapSubscription>[0]),
  },
  {
    key: "customers",
    probe: "customers",
    fetch: (s, since) => s.customers.list({ limit: PAGE, created: { gte: since } }),
    map: (o) => mapCustomer(o as unknown as Parameters<typeof mapCustomer>[0]),
  },
  {
    key: "refunds",
    probe: "charges",
    fetch: (s, since) => s.refunds.list({ limit: PAGE, created: { gte: since } }),
    map: (o) => mapRefund(o as unknown as Parameters<typeof mapRefund>[0]),
  },
  {
    key: "disputes",
    probe: "charges",
    fetch: (s, since) => s.disputes.list({ limit: PAGE, created: { gte: since } }),
    map: (o) => mapDispute(o as unknown as Parameters<typeof mapDispute>[0]),
  },
  {
    key: "balance_transactions",
    probe: "balance",
    fetch: (s, since) => s.balanceTransactions.list({ limit: PAGE, created: { gte: since } }),
    map: (o) => mapBalanceTransaction(o as unknown as Parameters<typeof mapBalanceTransaction>[0]),
  },
  {
    key: "payouts",
    probe: "balance",
    fetch: (s, since) => s.payouts.list({ limit: PAGE, created: { gte: since } }),
    map: (o) => mapPayout(o as unknown as Parameters<typeof mapPayout>[0]),
  },
];

/**
 * One "reporting" capability fetch that walks every resource. The cursor is a
 * JSON map of resource → last `created` epoch seconds so each resource can be
 * incremental independently.
 */
const reporting: CapabilityFetch = async (conn, cursor) => {
  const stripe = await clientFor(conn);
  let cursors: Record<string, string | null> = {};
  try {
    cursors = cursor ? (JSON.parse(cursor) as Record<string, string | null>) : {};
  } catch {
    cursors = {};
  }
  const items: SourceItemInput[] = [];
  let seen = 0;
  const errors: string[] = [];
  for (const r of RESOURCES) {
    if (probeFailed(conn, r.probe)) continue;
    const since = sinceFrom(cursors[r.key] ?? null);
    try {
      const res = await walk(() => r.fetch(stripe, since), r.key);
      seen += res.seen;
      for (const obj of res.objects) {
        const mapped = r.map(obj);
        if (mapped) items.push(mapped);
      }
      // Overlap by one hour so late-arriving objects with equal timestamps are not missed.
      cursors[r.key] = nextCursor(cursors[r.key] ?? null, res.maxCreated !== null ? res.maxCreated - 3600 : null);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `stripe_${r.key}_failed`);
    }
  }
  if (errors.length === RESOURCES.length) throw new Error(errors[0]);
  return { items, seen, cursor: JSON.stringify(cursors) };
};

export const stripeSyncAdapter: SyncAdapter = {
  provider: "stripe",
  capabilities: { reporting },
};
