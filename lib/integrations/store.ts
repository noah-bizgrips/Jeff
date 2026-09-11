import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson, encryptJson, type EncryptedSecret } from "@/lib/crypto/secrets";
import { redactString } from "@/lib/security/redact";
import type { ConnectionStatus, ConnectionSummary } from "./types";

/**
 * Connection persistence. All secret material goes through encryptJson /
 * decryptJson and the service-role client. Decrypted values NEVER leave the
 * server module that calls `readSecret`.
 */

export interface SecretBundle {
  kind: string;
  [key: string]: unknown;
}

export interface UpsertConnectionInput {
  ownerId: string;
  provider: string;
  displayName: string;
  status: ConnectionStatus;
  accessMode?: "read" | "read_write";
  scopes?: string[];
  capabilities?: string[];
  accountIdentifier?: string | null;
  externalAccountId?: string | null;
  metadata?: Record<string, unknown>;
  secret?: SecretBundle;
  secretExpiresAt?: string | null;
}

interface ConnectionRow {
  id: string;
  provider: string;
  display_name: string;
  status: ConnectionStatus;
  access_mode: "read" | "read_write";
  scopes: string[];
  capabilities: string[];
  account_identifier: string | null;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_error: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export function toSummary(row: ConnectionRow): ConnectionSummary {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    status: row.status,
    accessMode: row.access_mode,
    scopes: row.scopes ?? [],
    capabilities: row.capabilities ?? [],
    accountIdentifier: row.account_identifier,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok,
    lastError: row.last_error,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata ?? {},
  };
}

const SUMMARY_COLUMNS =
  "id, provider, display_name, status, access_mode, scopes, capabilities, account_identifier, last_test_at, last_test_ok, last_error, last_sync_at, created_at, updated_at, metadata";

export async function listConnections(ownerId: string): Promise<ConnectionSummary[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("connections")
    .select(SUMMARY_COLUMNS)
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`connections_list_failed:${error.code ?? ""}`);
  return (data as unknown as ConnectionRow[]).map(toSummary);
}

export async function getConnection(ownerId: string, id: string): Promise<ConnectionSummary | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("connections").select(SUMMARY_COLUMNS).eq("owner_id", ownerId).eq("id", id).maybeSingle();
  return data ? toSummary(data as unknown as ConnectionRow) : null;
}

export async function findConnectionByProvider(
  ownerId: string,
  provider: string,
  externalAccountId?: string | null,
): Promise<ConnectionSummary | null> {
  const admin = createAdminClient();
  let q = admin.from("connections").select(SUMMARY_COLUMNS).eq("owner_id", ownerId).eq("provider", provider);
  if (externalAccountId) q = q.eq("external_account_id", externalAccountId);
  const { data } = await q.order("created_at", { ascending: true }).limit(1).maybeSingle();
  return data ? toSummary(data as unknown as ConnectionRow) : null;
}

/**
 * Creates or replaces a connection (matched by owner+provider+external id)
 * and, when a secret bundle is supplied, encrypts and stores it.
 */
export async function upsertConnection(input: UpsertConnectionInput): Promise<ConnectionSummary> {
  const admin = createAdminClient();
  const existing = await findConnectionByProvider(input.ownerId, input.provider, input.externalAccountId ?? null);

  const values = {
    owner_id: input.ownerId,
    provider: input.provider,
    display_name: input.displayName,
    status: input.status,
    access_mode: input.accessMode ?? "read",
    scopes: input.scopes ?? [],
    capabilities: input.capabilities ?? [],
    account_identifier: input.accountIdentifier ?? null,
    external_account_id: input.externalAccountId ?? null,
    metadata: input.metadata ?? {},
    last_error: null,
  };

  let row: ConnectionRow;
  if (existing) {
    const { data, error } = await admin.from("connections").update(values).eq("id", existing.id).select(SUMMARY_COLUMNS).single();
    if (error) throw new Error(`connection_update_failed:${error.code ?? ""}`);
    row = data as unknown as ConnectionRow;
  } else {
    const { data, error } = await admin.from("connections").insert(values).select(SUMMARY_COLUMNS).single();
    if (error) throw new Error(`connection_insert_failed:${error.code ?? ""}`);
    row = data as unknown as ConnectionRow;
  }

  if (input.secret) {
    await writeSecret(row.id, input.secret, input.secretExpiresAt ?? null);
  }
  return toSummary(row);
}

export async function writeSecret(connectionId: string, bundle: SecretBundle, expiresAt: string | null) {
  const admin = createAdminClient();
  const enc = encryptJson(bundle, connectionId);
  const { error } = await admin.from("connection_secrets").upsert(
    {
      connection_id: connectionId,
      encryption_version: enc.version,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      auth_tag: enc.tag,
      secret_kind: bundle.kind,
      expires_at: expiresAt,
      rotated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id" },
  );
  if (error) throw new Error(`secret_write_failed:${error.code ?? ""}`);
}

/**
 * Decrypts the secret for a connection. Server-only. Callers must never
 * return the result to a client or include it in logs/audit metadata.
 */
export async function readSecret<T extends SecretBundle = SecretBundle>(connectionId: string): Promise<T | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("connection_secrets")
    .select("encryption_version, ciphertext, iv, auth_tag")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (!data) return null;
  const rec: EncryptedSecret = {
    version: data.encryption_version,
    ciphertext: data.ciphertext,
    iv: data.iv,
    tag: data.auth_tag,
  };
  return decryptJson<T>(rec, connectionId);
}

export async function setConnectionStatus(
  connectionId: string,
  patch: {
    status?: ConnectionStatus;
    lastTestOk?: boolean;
    lastError?: string | null;
    accountIdentifier?: string | null;
    metadata?: Record<string, unknown>;
    lastSyncAt?: string;
  },
) {
  const admin = createAdminClient();
  const update: Record<string, unknown> = {};
  if (patch.status) update.status = patch.status;
  if (patch.lastTestOk !== undefined) {
    update.last_test_ok = patch.lastTestOk;
    update.last_test_at = new Date().toISOString();
  }
  if (patch.lastError !== undefined) update.last_error = patch.lastError ? redactString(patch.lastError).slice(0, 500) : null;
  if (patch.accountIdentifier !== undefined) update.account_identifier = patch.accountIdentifier;
  if (patch.metadata) update.metadata = patch.metadata;
  if (patch.lastSyncAt) update.last_sync_at = patch.lastSyncAt;
  const { error } = await admin.from("connections").update(update).eq("id", connectionId);
  if (error) throw new Error(`connection_status_failed:${error.code ?? ""}`);
}

export async function deleteConnection(ownerId: string, connectionId: string): Promise<boolean> {
  const admin = createAdminClient();
  // connection_secrets cascades on delete.
  const { error, count } = await admin.from("connections").delete({ count: "exact" }).eq("owner_id", ownerId).eq("id", connectionId);
  if (error) throw new Error(`connection_delete_failed:${error.code ?? ""}`);
  return (count ?? 0) > 0;
}
