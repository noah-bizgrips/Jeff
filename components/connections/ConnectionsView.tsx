"use client";

import { useEffect, useState, type FormEvent } from "react";
import Script from "next/script";
import { useSearchParams } from "next/navigation";
import { Icon, SourceIcon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { AddNoteModal, ModalHeader } from "@/components/jeff/shared";
import type { ConnectionStatus, ConnectionSummary, ProviderDefinition } from "@/lib/integrations/types";
import { looksSensitiveClient } from "@/lib/security/client-redact";

export interface CatalogEntry extends ProviderDefinition {
  configured: boolean;
  missingEnv: string[];
}

export interface ServiceRequestItem {
  id: string;
  service_name: string;
  desired_capability: string;
  access_intent: string;
  status: string;
  classification_notes: string | null;
  matched_provider: string | null;
  created_at: string;
}

const STATUS: Record<ConnectionStatus, [string, string]> = {
  not_configured: ["Not configured", "neutral"],
  ready_for_setup: ["Ready for setup", "info"],
  authorization_required: ["Authorization required", "amber"],
  testing: ["Testing", "info"],
  connected: ["Connected", "ok"],
  limited: ["Limited", "amber"],
  reconnect_required: ["Reconnect required", "amber"],
  paused: ["Paused", "neutral"],
  error: ["Error", "danger"],
};

function StatusPill({ s }: { s: ConnectionStatus }) {
  const [label, tone] = STATUS[s] ?? [s, "neutral"];
  return <span className={`pill ${tone}`}>{label}</span>;
}

const PROVIDER_ICON: Record<string, string> = { google: "gmail", highlevel: "leadconnector", meta: "metaads" };
/** Providers with a server-side sync adapter (lib/integrations/sync/runner.ts). */
const SYNCABLE = ["google", "highlevel", "stripe", "plaid", "meta", "slack", "notion"];

function tokenDaysLeft(c: ConnectionSummary): number | null {
  const v = c.metadata.token_expires_at;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

function statusFor(p: CatalogEntry, conns: ConnectionSummary[]): ConnectionStatus {
  if (conns.length) return conns[0]!.status;
  if (p.authType === "api_key" && p.id === "stripe") return "ready_for_setup";
  return p.configured ? "ready_for_setup" : "not_configured";
}

export function ConnectionsView({ catalog, requests: initialRequests }: { catalog: CatalogEntry[]; requests: ServiceRequestItem[] }) {
  const jeff = useJeff();
  const params = useSearchParams();
  const [requests, setRequests] = useState(initialRequests);

  // Surface the OAuth callback result once.
  useEffect(() => {
    const err = params.get("oauth_error");
    const ok = params.get("connected");
    if (ok) jeff.toast(`${ok} connection verified.`);
    if (err) jeff.toast(`Authorization did not complete: ${err.replace(/_/g, " ")}.`);
    if (ok || err) {
      void jeff.refreshConnections();
      window.history.replaceState(null, "", "/connections");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = jeff.connections.filter((c) => ["connected", "limited"].includes(c.status)).length;
  const claude = catalog.find((p) => p.id === "claude");
  const providers = catalog.filter((p) => p.id !== "claude");

  return (
    <section className="page-view" id="connectionsView">
      <div className="preview-banner">
        <Icon name="lock" />
        <span>
          <strong>
            {live} live connection{live === 1 ? "" : "s"}.
          </strong>{" "}
          Secrets are entered only in protected forms, encrypted immediately, and never shown again. A connection is marked Connected only after a harmless verification test passes.
        </span>
      </div>

      {claude ? (
        <section className="worker-card">
          <div className="connection-top">
            <Icon name="sparkles" />
            <h3>Claude technical worker</h3>
            <span className={`pill ${jeff.aiEnabled ? "ok" : "neutral"}`}>{jeff.aiEnabled ? "Ask Jeff enabled" : "Worker not configured"}</span>
          </div>
          <p>{claude.description}</p>
          <div className="worker-capabilities">
            <span className="permission-tag">Isolated task workspace</span>
            <span className="permission-tag">Draft before publish</span>
            <span className="permission-tag">Budget &amp; time limits</span>
            <span className="permission-tag">No raw credentials</span>
          </div>
          <button className="button secondary" type="button" onClick={() => jeff.openModal(<GuideModal p={claude} />)}>
            View integration requirements <Icon name="arrowUpRight" />
          </button>
        </section>
      ) : null}

      <div className="section-label">KNOWLEDGE SOURCES &amp; ACTION TOOLS</div>
      <div className="connections-grid">
        {providers.map((p) => {
          const conns = jeff.connections.filter((c) => c.provider === p.id);
          const st = statusFor(p, conns);
          return (
            <article className="connection-card" key={p.id}>
              <div className="connection-top">
                <SourceIcon id={PROVIDER_ICON[p.id] ?? p.id} className="large" />
                <h3>{p.name}</h3>
                <StatusPill s={st} />
              </div>
              <p>{p.description}</p>
              {p.id === "plaid" ? <div className="powered">POWERED BY PLAID · READ-ONLY · NO MONEY MOVEMENT</div> : null}
              <div className="access-caption">
                <Icon name="lock" />
                {p.accessCaption}
              </div>
              {conns.map((c) => (
                <div className="status-line" key={c.id}>
                  <StatusPill s={c.status} />
                  <span>{c.accountIdentifier ?? c.displayName}</span>
                  {c.lastTestAt ? <span>· tested {new Date(c.lastTestAt).toLocaleDateString()}</span> : null}
                  {["connected", "limited"].includes(c.status) ? <span className={freshnessClass(c.lastSyncAt)}>· {freshnessText(c.lastSyncAt)}</span> : null}
                  {c.lastSyncAt ? <span>· synced {new Date(c.lastSyncAt).toLocaleString()}</span> : null}
                  {c.lastError ? <span className="warning-copy">· {c.lastError}</span> : null}
                  {tokenDaysLeft(c) !== null && tokenDaysLeft(c)! < 10 ? (
                    <span className="warning-copy">· token expires in {Math.max(0, tokenDaysLeft(c)!)} day{tokenDaysLeft(c) === 1 ? "" : "s"} — re-authorize</span>
                  ) : null}
                  {c.metadata.last_test_details && typeof c.metadata.last_test_details === "object" ? (
                    <span>
                      ·{" "}
                      {Object.entries(c.metadata.last_test_details as Record<string, unknown>)
                        .filter(([, v]) => typeof v === "boolean")
                        .map(([k, v]) => `${k} ${v ? "✓" : "✗"}`)
                        .join(" ")}
                    </span>
                  ) : null}
                </div>
              ))}
              <div className="connection-actions">
                <button className="button secondary" type="button" onClick={() => jeff.openModal(<SetupModal p={p} conns={conns} />)}>
                  {conns.length ? "Manage" : "Connection setup"}
                </button>
                {jeff.mode === "demo" ? (
                  <button className="button secondary" type="button" onClick={() => toggleDemoSources(p, jeff)}>
                    {demoSourcesOn(p, jeff) ? "Remove sample" : "Add sample"}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <section className="signal-strip">
        <div>
          <span className="mini-eyebrow">ADD A SERVICE</span>
          <h3>Tell Jeff what you want to connect.</h3>
          <p>Jeff identifies the supported official API/OAuth path, records the request, and prepares a connector through a reviewed branch. Nothing is installed or executed automatically. Secrets go into protected setup forms, never chat.</p>
        </div>
        <button className="button primary" type="button" onClick={() => jeff.openModal(<AddServiceModal onCreated={(r) => setRequests((rs) => [r, ...rs])} />)}>
          Add a service <Icon name="plus" />
        </button>
      </section>

      {requests.length ? (
        <>
          <div className="section-label">SERVICE REQUESTS</div>
          <div className="audit-list">
            {requests.map((r) => (
              <div className="audit-row" key={r.id}>
                <Icon name="plug" />
                <div>
                  <strong>
                    {r.service_name} — {r.desired_capability}
                  </strong>
                  <p>
                    {r.status.replace(/_/g, " ")} · {r.access_intent === "read" ? "read-only" : "read/write"}
                    {r.classification_notes ? ` · ${r.classification_notes}` : ""}
                  </p>
                </div>
                <span>{new Date(r.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <section className="signal-strip">
        <div>
          <span className="mini-eyebrow">YOUR OWN CONTEXT</span>
          <h3>Add a note to your brain.</h3>
          <p>{jeff.mode === "live" ? "Notes are stored privately in Jeff's database." : "Demo notes stay in this tab only."} Do not paste confidential credentials.</p>
        </div>
        <button className="button secondary" type="button" onClick={() => jeff.openModal(<AddNoteModal />)}>
          Add note <Icon name="plus" />
        </button>
      </section>
    </section>
  );
}

/** Data freshness (spec §44) from the last successful sync; thresholds mirror lib/jeff/freshness.ts. */
function freshnessText(lastSyncAt: string | null): string {
  if (!lastSyncAt) return "no data synced yet";
  const h = (Date.now() - Date.parse(lastSyncAt)) / 3_600_000;
  const age = h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  return h > 36 ? `data ${age} old (stale)` : `data ${age} old`;
}
function freshnessClass(lastSyncAt: string | null): string {
  if (!lastSyncAt) return "warning-copy";
  return (Date.now() - Date.parse(lastSyncAt)) / 3_600_000 > 36 ? "warning-copy" : "";
}

const DEMO_SOURCE_IDS: Record<string, string[]> = {
  google: ["gmail", "drive", "calendar"],
  highlevel: ["leadconnector"],
  meta: ["metaads", "facebook", "instagram"],
};
function demoSourcesOn(p: CatalogEntry, jeff: ReturnType<typeof useJeff>) {
  return (DEMO_SOURCE_IDS[p.id] ?? [p.id]).some((id) => jeff.sources.has(id));
}
function toggleDemoSources(p: CatalogEntry, jeff: ReturnType<typeof useJeff>) {
  for (const id of DEMO_SOURCE_IDS[p.id] ?? [p.id]) jeff.toggleSource(id);
}

/* ------------------------------------------------------------------ */
/* Setup modal: routes to the provider-specific flow                   */
/* ------------------------------------------------------------------ */

function SetupModal({ p, conns }: { p: CatalogEntry; conns: ConnectionSummary[] }) {
  const jeff = useJeff();
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  async function syncNow(c: ConnectionSummary) {
    setSyncing(c.id);
    try {
      const res = await fetch(`/api/sync/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: c.id }) });
      const data = (await res.json().catch(() => null)) as { results?: { capability: string; seen: number; upserted: number; error?: string | null }[]; error?: string } | null;
      if (!res.ok || !data?.results) return jeff.toast(`Sync failed (${data?.error ?? res.status}).`);
      const parts = data.results.map((r) => (r.error ? `${r.capability}: error` : `${r.capability}: ${r.upserted} of ${r.seen}`));
      jeff.toast(`Synced — ${parts.join(", ")}.`);
      await jeff.refreshConnections();
    } finally {
      setSyncing(null);
    }
  }
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  async function test(connectionId?: string) {
    setTesting(connectionId ?? "new");
    setResult(null);
    try {
      const res = await fetch(`/api/integrations/${p.id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(connectionId ? { connectionId } : {}) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; details?: unknown; missingEnv?: string[] } | null;
      setResult(data ?? { error: `HTTP ${res.status}` });
      if (data?.ok) jeff.toast(`${p.name} verified.`);
      else jeff.toast(`${p.name} test failed${data?.error ? `: ${data.error}` : ""}.`);
      await jeff.refreshConnections();
    } finally {
      setTesting(null);
    }
  }

  async function remove(c: ConnectionSummary) {
    if (!confirm(`Remove ${c.displayName}? The stored credential is deleted.`)) return;
    const res = await fetch(`/api/connections/${c.id}`, { method: "DELETE" });
    if (!res.ok) return jeff.toast("Could not remove the connection.");
    await jeff.refreshConnections();
    jeff.toast("Connection removed and credential deleted.");
    jeff.closeModal();
  }

  return (
    <>
      <ModalHeader title={`${p.name} connection`} desc={p.setupSummary} eyebrow={`INTEGRATION / ${p.authType.replace("_", " ").toUpperCase()}`} />
      <div className="modal-body">
        <div className="section-label">PERMISSION BOUNDARY</div>
        <p className="detail-content">{p.permissionBoundary}</p>
        {p.capabilities.length > 1 ? (
          <div className="worker-capabilities">
            {p.capabilities.map((c) => (
              <span className="permission-tag" key={c.id} title={c.description}>
                {c.name} · {c.access === "read" ? "read" : "read/write"}
              </span>
            ))}
          </div>
        ) : null}

        {!p.configured && p.requiredEnv.length ? (
          <div className="callout">
            <strong>Server configuration required.</strong> Add these variables in Vercel → Project → Settings → Environment Variables (mark secrets Sensitive): <code>{p.missingEnv.join(", ")}</code>. Values are never entered here.
          </div>
        ) : null}

        {conns.length ? (
          <>
            <div className="section-label">YOUR CONNECTIONS</div>
            {conns.map((c) => (
              <div className="policy-row" key={c.id}>
                <div>
                  <strong>{c.displayName}</strong>
                  <small>
                    {c.accountIdentifier ?? "—"} · scopes: {c.scopes.length ? c.scopes.join(", ") : "—"}
                    {c.lastError ? ` · ${c.lastError}` : ""}
                  </small>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <StatusPill s={c.status} />
                  <button className="button secondary" type="button" disabled={testing !== null} onClick={() => test(c.id)}>
                    {testing === c.id ? <span className="spinner" /> : <Icon name="refresh" />}
                    Test
                  </button>
                  {SYNCABLE.includes(p.id) && ["connected", "limited"].includes(c.status) ? (
                    <button className="button secondary" type="button" disabled={syncing !== null} onClick={() => syncNow(c)}>
                      {syncing === c.id ? <span className="spinner" /> : <Icon name="download" />}
                      Sync now
                    </button>
                  ) : null}
                  {(p.id === "meta" || p.id === "github") && ["connected", "limited"].includes(c.status) ? (
                    <button className="button secondary" type="button" onClick={() => jeff.openModal(<PermissionsModal p={p} c={c} />)}>
                      Select accounts
                    </button>
                  ) : null}
                  <button className="button secondary danger-button" type="button" onClick={() => remove(c)}>
                    <Icon name="trash" />
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : null}

        {result ? <div className="diff-preview">{JSON.stringify(result, null, 2)}</div> : null}

        <div className="section-label">{conns.length ? "ADD ANOTHER / RECONNECT" : "SET UP"}</div>
        {p.authType === "oauth2" ? (
          <p className="detail-content">
            Authorize in a new window. You will see exactly which read-only permissions are requested. Jeff verifies the grant with a harmless read before marking it Connected.
          </p>
        ) : null}
        {p.id === "stripe" ? <StripeForm /> : null}
        {p.id === "plaid" ? <PlaidLinkButton configured={p.configured} /> : null}

        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Close
          </button>
          <a className="button secondary" href={p.docsUrl} target="_blank" rel="noopener noreferrer">
            Official docs <Icon name="arrowUpRight" />
          </a>
          {p.authType === "oauth2" ? (
            p.configured ? (
              <a className="button primary" href={`/api/oauth/${p.oauthSlug ?? p.id}/start`}>
                Authorize {p.name} <Icon name="arrowUpRight" />
              </a>
            ) : (
              <button className="button primary" type="button" disabled>
                Authorize (configure first)
              </button>
            )
          ) : null}
          {p.id === "n8n" || p.id === "github" ? (
            <button className="button primary" type="button" disabled={!p.configured || testing !== null} onClick={() => test()}>
              {testing === "new" ? <span className="spinner" /> : <Icon name="check" />}
              Verify connection
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function GuideModal({ p }: { p: CatalogEntry }) {
  const jeff = useJeff();
  return (
    <>
      <ModalHeader title={p.name} desc={p.setupSummary} eyebrow="WORKER / REQUIREMENTS" />
      <div className="modal-body">
        <div className="section-label">PERMISSION BOUNDARY</div>
        <p className="detail-content">{p.permissionBoundary}</p>
        <div className="section-label">CONFIGURATION</div>
        <p className="detail-content">
          {p.configured ? "ANTHROPIC_API_KEY is configured on the server. Ask Jeff is live." : `Missing on the server: ${p.missingEnv.join(", ")}. Add it in Vercel (Sensitive).`} Sandbox execution (Vercel Sandbox) stays disabled until a mission is approved.
        </p>
        <div className="modal-actions">
          <button className="button primary" type="button" onClick={jeff.closeModal}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stripe: protected restricted-key form                               */
/* ------------------------------------------------------------------ */

function StripeForm() {
  const jeff = useJeff();
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("restrictedKey") as HTMLInputElement;
    const key = input.value.trim();
    input.value = ""; // never keep the key in state or the DOM longer than needed
    if (!/^rk_(live|test)_/.test(key)) return setOutcome("Use a RESTRICTED key (starts with rk_live_ or rk_test_). Secret keys are refused.");
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/integrations/stripe/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ restrictedKey: key, label: label || undefined }) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; hint?: string; details?: Record<string, boolean> } | null;
      if (!res.ok) setOutcome(data?.hint ?? `Rejected: ${data?.error ?? res.status}`);
      else if (data?.ok) {
        setOutcome(`Verified. Readable: ${Object.entries(data.details ?? {}).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
        jeff.toast("Stripe verified (read-only).");
      } else setOutcome(`Stored but verification failed: ${data?.error ?? "unknown"}`);
      await jeff.refreshConnections();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={onSubmit} autoComplete="off">
      <div className="callout">
        In Stripe: Developers → API keys → <strong>Create restricted key</strong>. Grant only <em>Read</em> on Customers, Charges, Invoices, Subscriptions, Products, Balance, Disputes, Payouts. No write permissions. Paste it once here — it is encrypted immediately and never displayed again.
      </div>
      <label className="field">
        Label (optional)
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="BizGrips live (read-only)" />
      </label>
      <label className="field">
        Restricted key
        <input name="restrictedKey" type="password" autoComplete="off" spellCheck={false} placeholder="rk_live_…" required />
      </label>
      {outcome ? <div className="callout">{outcome}</div> : null}
      <div>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : <Icon name="lock" />}
          Encrypt &amp; verify
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Plaid Link                                                          */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    Plaid?: {
      create: (cfg: {
        token: string;
        onSuccess: (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null }) => void;
        onExit?: (err: unknown) => void;
      }) => { open: () => void };
    };
  }
}

function PlaidLinkButton({ configured }: { configured: boolean }) {
  const jeff = useJeff();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!window.Plaid) return jeff.toast("Plaid Link is still loading.");
    setBusy(true);
    try {
      const res = await fetch("/api/plaid/link-token", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { linkToken?: string; error?: string; env?: string } | null;
      if (!res.ok || !data?.linkToken) return jeff.toast(`Could not start Plaid Link (${data?.error ?? res.status}).`);
      const handler = window.Plaid.create({
        token: data.linkToken,
        onSuccess: async (publicToken, metadata) => {
          const ex = await fetch("/api/plaid/exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publicToken, institution: metadata.institution ? { id: metadata.institution.institution_id, name: metadata.institution.name } : undefined }),
          });
          const out = (await ex.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          jeff.toast(out?.ok ? "Financial account connected (read-only)." : `Connection stored but verification failed: ${out?.error ?? ex.status}`);
          await jeff.refreshConnections();
        },
        onExit: () => setBusy(false),
      });
      handler.open();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-grid">
      <Script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js" strategy="afterInteractive" onLoad={() => setReady(true)} />
      <div className="callout">
        Plaid Link opens in a secure window from Plaid. Jeff requests <strong>Transactions only</strong>. Your bank credentials are entered with Plaid, never with Jeff. The resulting access token is stored encrypted server-side.
      </div>
      <div>
        <button className="button primary" type="button" disabled={!configured || !ready || busy} onClick={start}>
          {busy ? <span className="spinner" /> : <Icon name="plug" />}
          Connect a financial account
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Meta / GitHub asset selection                                       */
/* ------------------------------------------------------------------ */

interface MetaAssets {
  adAccounts: { id: string; name: string }[];
  pages: { id: string; name: string }[];
  instagramAccounts: { id: string; name: string; pageId: string }[];
}
interface GithubAssets {
  installation: { id: number; account: string };
  repositories: { id: number; fullName: string; private: boolean; defaultBranch: string }[];
}

function PermissionsModal({ p, c }: { p: CatalogEntry; c: ConnectionSummary }) {
  const jeff = useJeff();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<MetaAssets | GithubAssets[] | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({
    selected_ad_accounts: (c.metadata.selected_ad_accounts as string[]) ?? [],
    selected_pages: (c.metadata.selected_pages as string[]) ?? [],
    selected_instagram_accounts: (c.metadata.selected_instagram_accounts as string[]) ?? [],
    selected_repositories: (c.metadata.selected_repositories as string[]) ?? [],
  });
  const [installationId, setInstallationId] = useState<number | undefined>(c.metadata.installation_id as number | undefined);

  useEffect(() => {
    fetch(`/api/connections/${c.id}/permissions`)
      .then((r) => r.json())
      .then((d: { assets: MetaAssets | GithubAssets[] | null }) => setAssets(d.assets))
      .catch(() => jeff.toast("Could not load selectable accounts."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);

  function toggle(key: string, id: string) {
    setSelected((s) => {
      const cur = s[key] ?? [];
      return { ...s, [key]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });
  }

  async function save() {
    const res = await fetch(`/api/connections/${c.id}/permissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selected, installation_id: installationId }),
    });
    if (!res.ok) return jeff.toast("Could not save the selection.");
    await jeff.refreshConnections();
    jeff.toast("Selection saved. Jeff analyzes only the selected accounts.");
    jeff.closeModal();
  }

  function list(key: string, items: { id: string; name: string }[]) {
    return (
      <div className="checkbox-list">
        {items.length ? (
          items.map((it) => (
            <label key={it.id}>
              <input type="checkbox" checked={(selected[key] ?? []).includes(it.id)} onChange={() => toggle(key, it.id)} />
              <span>{it.name}</span>
              <small className="muted">{it.id}</small>
            </label>
          ))
        ) : (
          <p className="muted">None available.</p>
        )}
      </div>
    );
  }

  return (
    <>
      <ModalHeader title={`${p.name}: select what Jeff may analyze`} desc="Only selected accounts are read. You can change this any time." eyebrow="PERMISSIONS" />
      <div className="modal-body">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : p.id === "meta" && assets && !Array.isArray(assets) ? (
          <>
            <div className="section-label">AD ACCOUNTS</div>
            {list("selected_ad_accounts", assets.adAccounts)}
            <div className="section-label">FACEBOOK PAGES</div>
            {list("selected_pages", assets.pages)}
            <div className="section-label">INSTAGRAM PROFESSIONAL ACCOUNTS</div>
            {list("selected_instagram_accounts", assets.instagramAccounts)}
          </>
        ) : p.id === "github" && Array.isArray(assets) ? (
          assets.map((inst) => (
            <div key={inst.installation.id}>
              <div className="section-label">
                <label>
                  <input type="radio" name="installation" checked={installationId === inst.installation.id} onChange={() => setInstallationId(inst.installation.id)} /> INSTALLATION: {inst.installation.account}
                </label>
              </div>
              {list(
                "selected_repositories",
                inst.repositories.map((r) => ({ id: r.fullName, name: `${r.fullName}${r.private ? " (private)" : ""}` })),
              )}
            </div>
          ))
        ) : (
          <p className="muted">Nothing to select for this provider.</p>
        )}
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Cancel
          </button>
          <button className="button primary" type="button" onClick={save} disabled={loading}>
            Save selection
          </button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Add a service                                                       */
/* ------------------------------------------------------------------ */

function AddServiceModal({ onCreated }: { onCreated: (r: ServiceRequestItem) => void }) {
  const jeff = useJeff();
  const [name, setName] = useState("");
  const [capability, setCapability] = useState("");
  const [intent, setIntent] = useState<"read" | "read_write">("read");
  const [resources, setResources] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ServiceRequestItem | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (looksSensitiveClient(`${name} ${capability}`)) return jeff.toast("Do not include credentials in a service request.");
    setBusy(true);
    try {
      const res = await fetch("/api/service-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceName: name.trim(),
          desiredCapability: capability.trim(),
          accessIntent: intent,
          requestedResources: resources
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const data = (await res.json().catch(() => null)) as { request?: ServiceRequestItem; error?: string } | null;
      if (!res.ok || !data?.request) return jeff.toast(`Could not record the request (${data?.error ?? res.status}).`);
      setResult(data.request);
      onCreated(data.request);
    } finally {
      setBusy(false);
    }
  }

  const STATUS_TEXT: Record<string, string> = {
    existing_connector: "Existing connector — use its setup flow above.",
    connector_can_be_prepared: "A connector can be prepared through a reviewed Git branch.",
    manual_investigation_required: "Jeff will investigate the official integration method first.",
    unsupported: "Not supported: Jeff only uses official APIs with explicit authorization.",
  };

  return (
    <>
      <ModalHeader title="Add a service" desc="Jeff, add [service] as an integration." eyebrow="CONNECTIONS / REQUEST" />
      {result ? (
        <div className="modal-body">
          <div className="callout">
            <strong>{STATUS_TEXT[result.status] ?? result.status}</strong>
            <br />
            {result.classification_notes}
          </div>
          <div className="modal-actions">
            <button className="button primary" type="button" onClick={jeff.closeModal}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="modal-body form-grid" onSubmit={submit}>
          <label className="field">
            Service name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="QuickBooks, HubSpot, Zoom…" />
          </label>
          <label className="field">
            What should Jeff be able to do?
            <textarea value={capability} onChange={(e) => setCapability(e.target.value)} required maxLength={1000} placeholder="Read invoices and expenses for cash-flow analysis" />
          </label>
          <label className="field">
            Access intention
            <select value={intent} onChange={(e) => setIntent(e.target.value as "read" | "read_write")}>
              <option value="read">Read-only (recommended)</option>
              <option value="read_write">Read and write (requires approval design)</option>
            </select>
          </label>
          <label className="field">
            Resources (comma separated, optional)
            <input value={resources} onChange={(e) => setResources(e.target.value)} maxLength={200} placeholder="invoices, expenses, customers" />
          </label>
          <div className="callout">No packages are installed and no remote code runs from this form. Requests are classified, recorded, and implemented through review.</div>
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={jeff.closeModal}>
              Cancel
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="plus" />}
              Submit request
            </button>
          </div>
        </form>
      )}
    </>
  );
}
