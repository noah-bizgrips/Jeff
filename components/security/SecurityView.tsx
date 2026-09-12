"use client";

import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";

export interface AuditRow {
  id: number;
  event: string;
  provider: string | null;
  actor: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface SecurityFacts {
  ownerEmail: string;
  aal: "aal1" | "aal2";
  factors: { id: string; name: string | null; status: string }[];
  encryptionConfigured: boolean;
  ownerBound: boolean;
  anthropicConfigured: boolean;
  aiSpentTodayUsd: number;
  aiBudgetUsd: number;
  connectionsCount: number;
  audit: AuditRow[];
}

function Row({ title, desc, label, tone = "" }: { title: string; desc: string; label: string; tone?: string }) {
  return (
    <div className="policy-row">
      <div>
        <strong>{title}</strong>
        <small>{desc}</small>
      </div>
      <span className={`pill ${tone}`}>{label}</span>
    </div>
  );
}

export function SecurityView({ facts }: { facts: SecurityFacts }) {
  const jeff = useJeff();
  const verified = facts.aal === "aal2";
  const verifiedFactors = facts.factors.filter((f) => f.status === "verified");
  return (
    <section className="page-view" id="securityView">
      <div className="security-hero">
        <div className="shield-art">
          <Icon name="lock" />
        </div>
        <div>
          <span className="mini-eyebrow">SINGLE-OWNER WORKSPACE</span>
          <h2>Your context stays on your terms.</h2>
          <p>
            One permitted identity. Two-factor authentication.
            <br />
            Credentials belong behind the interface, not inside it.
          </p>
        </div>
        <span className={`pill ${verified ? "ok" : "amber"}`}>{verified ? "Server-verified session (AAL2)" : "MFA not verified"}</span>
      </div>
      <div className="preview-banner">
        <Icon name="info" />
        <span>
          <strong>Enforced on the server.</strong> The proxy layer and every API route re-verify the owner identity and MFA level from signed JWT claims. Row-level security enforces the same rules in the database.
        </span>
      </div>
      <div className="security-grid">
        <section className="security-card">
          <h3>Identity &amp; two-factor access</h3>
          <p>Only the exact owner account may enter the hosted workspace. No self-service signup.</p>
          <div className="owner-line">
            <Icon name="user" />
            <div>
              <strong>{facts.ownerEmail}</strong>
              <small>Email + immutable user id pinned in server configuration</small>
            </div>
          </div>
          <Row title="Password + authenticator" desc="A valid password alone never unlocks Jeff." label={verified ? "AAL2 verified" : "AAL1 only"} tone={verified ? "ok" : "amber"} />
          <Row title="Verified email + fixed account ID" desc="Another account, alias, or changed address is rejected." label="Enforced" tone="ok" />
          <Row title="Database owner binding" desc="app_owner row mirrors OWNER_USER_ID for row-level security." label={facts.ownerBound ? "Bound" : "Not bound"} tone={facts.ownerBound ? "ok" : "amber"} />
          <Row title="Authenticator apps" desc={verifiedFactors.length ? verifiedFactors.map((f) => f.name ?? f.id.slice(0, 8)).join(", ") : "No verified TOTP factor."} label={`${verifiedFactors.length} enrolled`} tone={verifiedFactors.length ? "ok" : "amber"} />
          <Link className="button secondary" href="/mfa">
            <Icon name="lock" />
            Manage authenticator
          </Link>
        </section>
        <section className="security-card">
          <h3>Secrets &amp; private links</h3>
          <p>The interface receives status and opaque references, not source credentials.</p>
          <Row title="Encrypted credential store" desc="AES-256-GCM, per-record IV, server-only key." label={facts.encryptionConfigured ? "Configured" : "Key missing"} tone={facts.encryptionConfigured ? "ok" : "danger"} />
          <Row title="No client access to secrets" desc="connection_secrets has no RLS policies; only server code can read it." label="Enforced" tone="ok" />
          <Row title="No third-party trackers or CDNs" desc="Strict CSP with per-request nonces. Only Supabase and Plaid Link are allowed." label="Enforced" tone="ok" />
          <Row title="Log redaction" desc="Token patterns are scrubbed before anything is logged or audited." label="Enabled" tone="ok" />
        </section>
        <section className="security-card">
          <h3>Agent execution boundaries</h3>
          <p>A prompt is not a security policy. These controls exist outside the agent.</p>
          <Row title="Model never sees credentials" desc="Ask Jeff calls narrow server-side tools; provider tokens stay in the broker." label={facts.anthropicConfigured ? "Active" : "Key not set"} tone={facts.anthropicConfigured ? "ok" : "amber"} />
          <Row
            title="Daily AI budget"
            desc={`$${facts.aiSpentTodayUsd.toFixed(2)} of $${facts.aiBudgetUsd.toFixed(2)} used today (UTC). Jeff refuses new AI calls past the cap.`}
            label={facts.aiSpentTodayUsd >= facts.aiBudgetUsd ? "Exhausted" : "Enforced"}
            tone={facts.aiSpentTodayUsd >= facts.aiBudgetUsd ? "amber" : "ok"}
          />
          <Row title="Production actions are disabled" desc="No merge, publish, messages, deployments, or money movement in V1." label="Blocked" tone="ok" />
          <Row title="Version-bound approval + fresh MFA" desc="Approvals record the exact artifact, environment, expiry and AAL." label="Implemented" tone="ok" />
          <Row title="Sandbox worker" desc="Vercel Sandbox execution scaffolded; disabled until missions are approved." label="Scaffolded" tone="amber" />
        </section>
        <section className="security-card">
          <h3>Sessions &amp; data handling</h3>
          <p>Supabase Auth sessions in HttpOnly cookies, refreshed by the server, verified by signature on every request.</p>
          <Row title="Secure, HttpOnly, SameSite cookies" desc="Access tokens never reach JavaScript." label="Enabled" tone="ok" />
          <Row title="Signed-claim verification" desc="getClaims() checks the JWT signature; a forged cookie is rejected." label="Enabled" tone="ok" />
          <Row title="Connections" desc={`${facts.connectionsCount} stored connection${facts.connectionsCount === 1 ? "" : "s"}.`} label="Encrypted" tone="ok" />
          <Row title="Workspace mode" desc="Sample data is only shown in Demo mode and never mixed into live analysis." label={jeff.mode === "live" ? "Live" : "Demo"} tone={jeff.mode === "live" ? "ok" : "amber"} />
        </section>
      </div>
      <div className="section-label">AUDIT LOG</div>
      <div className="audit-list">
        {facts.audit.length ? (
          facts.audit.map((a) => (
            <div className="audit-row" key={a.id}>
              <Icon name="lock" />
              <div>
                <strong>{a.event.replace(/_/g, " ")}</strong>
                <p>
                  {a.actor}
                  {a.provider ? ` · ${a.provider}` : ""}
                  {Object.keys(a.metadata).length ? ` · ${JSON.stringify(a.metadata).slice(0, 160)}` : ""}
                </p>
              </div>
              <span>{new Date(a.createdAt).toLocaleString()}</span>
            </div>
          ))
        ) : (
          <div className="audit-row">
            <p>No audit events yet.</p>
          </div>
        )}
      </div>
      <div className="security-lockbar">
        <div>
          <strong>Your controls should be easy to reach.</strong>
          <p>Sign-out revokes this session everywhere. Existing external effects cannot be undone by logging out.</p>
        </div>
        <form action="/auth/signout" method="post">
          <button className="button secondary danger-button" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </section>
  );
}
