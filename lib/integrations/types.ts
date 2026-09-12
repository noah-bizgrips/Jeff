export type ConnectionStatus =
  | "not_configured"
  | "ready_for_setup"
  | "authorization_required"
  | "testing"
  | "connected"
  | "limited"
  | "reconnect_required"
  | "paused"
  | "error";

export type AuthType = "oauth2" | "api_key" | "plaid_link" | "github_app" | "none";
export type ConnectionType = "knowledge_source" | "action_tool" | "financial" | "worker";
export type AccessMode = "read" | "read_write";

export interface ProviderCapability {
  id: string;
  name: string;
  description: string;
  access: AccessMode;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  description: string;
  color: string;
  connectionType: ConnectionType;
  authType: AuthType;
  /** Route segment for OAuth start/callback when it must differ from id. */
  oauthSlug?: string;
  capabilities: ProviderCapability[];
  /** Default access classification at V1. */
  access: AccessMode;
  /** Env var NAMES (never values) required before setup can start. */
  requiredEnv: string[];
  /** Official documentation for the integration path. */
  docsUrl: string;
  /** Non-secret setup hints shown in the UI. */
  setupSummary: string;
  permissionBoundary: string;
  /** Tag line shown under the card. */
  accessCaption: string;
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  displayName: string;
  status: ConnectionStatus;
  accessMode: AccessMode;
  scopes: string[];
  capabilities: string[];
  accountIdentifier: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}
