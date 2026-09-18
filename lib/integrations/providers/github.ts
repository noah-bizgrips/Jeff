import "server-only";
import { createSign } from "node:crypto";
import type { TestResult } from "./base";
import { fetchJson } from "./base";
import { hasEnv, requireEnv } from "@/lib/env";
import type { ConnectionSummary } from "@/lib/integrations/types";

/**
 * GitHub App adapter. The private key stays in env (base64 PEM); this module
 * mints short-lived JWTs and installation tokens on demand. Tokens are never
 * stored or returned to clients.
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "read",
  metadata: "read",
  issues: "read",
} as const;

export function githubConfigured() {
  return ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_B64"].every(hasEnv);
}

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

/** RS256 app JWT valid for ~9 minutes. */
export function appJwt(): string {
  const appId = requireEnv("GITHUB_APP_ID");
  const pem = Buffer.from(requireEnv("GITHUB_APP_PRIVATE_KEY_B64"), "base64").toString("utf8");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(pem).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

const GH = "https://api.github.com";
const ghHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "gomez-bizgrips",
});

export async function listInstallations() {
  const { status, body } = await fetchJson<{ id: number; account?: { login?: string }; permissions?: Record<string, string> }[]>(
    `${GH}/app/installations`,
    { headers: ghHeaders(appJwt()) },
  );
  if (status !== 200 || !Array.isArray(body)) throw new Error(`github_installations_failed:${status}`);
  return body.map((i) => ({ id: i.id, account: i.account?.login ?? String(i.id), permissions: i.permissions ?? {} }));
}

/** Mints an installation token (1h). Used by server-side broker only. */
export async function installationToken(installationId: number): Promise<string> {
  const { status, body } = await fetchJson<{ token?: string }>(`${GH}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: ghHeaders(appJwt()),
  });
  if (status !== 201 || !body?.token) throw new Error(`github_installation_token_failed:${status}`);
  return body.token;
}

export async function listInstallationRepos(installationId: number) {
  const token = await installationToken(installationId);
  const { status, body } = await fetchJson<{ repositories?: { id: number; full_name: string; private: boolean; default_branch: string }[] }>(
    `${GH}/installation/repositories?per_page=100`,
    { headers: ghHeaders(token) },
  );
  if (status !== 200) throw new Error(`github_repos_failed:${status}`);
  return (body?.repositories ?? []).map((r) => ({ id: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch }));
}

export async function testGithubApp(conn: ConnectionSummary): Promise<TestResult> {
  if (!githubConfigured()) return { ok: false, error: "github_app_not_configured" };
  try {
    const installs = await listInstallations();
    const installationId = Number(conn.metadata.installation_id ?? installs[0]?.id);
    if (!installationId) return { ok: false, error: "github_app_not_installed" };
    const repos = await listInstallationRepos(installationId);
    const inst = installs.find((i) => i.id === installationId);
    const risky = Object.entries(inst?.permissions ?? {}).filter(([k, v]) => ["administration", "secrets", "organization_administration"].includes(k) && v !== "none");
    return {
      ok: true,
      limited: risky.length > 0,
      accountIdentifier: inst?.account ?? null,
      details: { repositories: repos.map((r) => r.fullName), permissions: inst?.permissions ?? {}, riskyPermissions: risky.map(([k]) => k) },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "github_test_failed" };
  }
}
