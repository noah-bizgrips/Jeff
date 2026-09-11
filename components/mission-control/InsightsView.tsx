"use client";

import { useState } from "react";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState, MemoryRow, ModalHeader } from "@/components/jeff/shared";
import type { DemoInsight } from "@/lib/jeff/demo-data";

export interface FindingItem {
  id: string;
  category: string;
  title: string;
  observedFacts: unknown[];
  metrics: Record<string, unknown>;
  interpretation: string | null;
  evidence: { source_item_id?: string; provider?: string; url?: string; title?: string }[];
  rangeStart: string | null;
  rangeEnd: string | null;
  confidence: number | null;
  limitations: string | null;
  severity: string;
  status: string;
  proposedMission: { title?: string; goal?: string } | null;
  createdAt: string;
  isSample: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  lead_followup_gap: "LEAD FOLLOW-UP",
  pipeline_aging: "PIPELINE AGING",
  onboarding_blocker: "CLIENT ONBOARDING",
  missed_commitment: "COMMITMENTS",
  automation_failure: "AUTOMATION HEALTH",
  failed_payment: "BILLING",
  cashflow_change: "CASH FLOW",
  recurring_expense_change: "RECURRING EXPENSES",
  ad_spend_change: "AD SPEND",
  operational_bottleneck: "OPERATIONS",
  automation_opportunity: "AUTOMATION OPPORTUNITY",
};

export function InsightsView({ findings, demoInsights, liveMonitors }: { findings: FindingItem[]; demoInsights: DemoInsight[]; liveMonitors: number }) {
  const jeff = useJeff();
  const demo = jeff.mode === "demo";

  async function prepare(goal: string, title?: string) {
    const res = await fetch("/api/missions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal, title }) });
    if (!res.ok) return jeff.toast("Could not create the task draft.");
    jeff.closeModal();
    jeff.toast("Task draft created. Nothing runs until you approve it.");
    jeff.navigate("/missions");
  }

  return (
    <section className="page-view" id="insightsView">
      <div className="preview-banner">
        <Icon name="info" />
        <span>
          {demo ? (
            <>
              These are <strong>illustrative findings</strong>, not analysis of your accounts. Switch to Live to see real findings.
            </>
          ) : (
            <>
              Findings separate <strong>observed facts</strong>, <strong>calculated metrics</strong>, and <strong>AI interpretation</strong>, with evidence and limitations.
            </>
          )}
        </span>
      </div>
      <div className="metric-grid">
        <div className="metric-box">
          <small>Live monitors</small>
          <strong>{liveMonitors}</strong>
          <p>{liveMonitors ? "Running on schedule" : "Enabled after sources sync"}</p>
        </div>
        <div className="metric-box">
          <small>{demo ? "Example opportunities" : "Open findings"}</small>
          <strong>{demo ? demoInsights.length : findings.filter((f) => f.status === "open").length}</strong>
          <p>{demo ? "Evidence linked to sample records" : "Evidence linked to synced records"}</p>
        </div>
        <div className="metric-box">
          <small>Verified improvement</small>
          <strong>&mdash;</strong>
          <p>No baseline or outcome data yet</p>
        </div>
      </div>
      <div className="insight-grid">
        {demo
          ? demoInsights.map((i) => (
              <article className="insight-card" key={i.id}>
                <span className="mini-eyebrow">{i.label}</span>
                <h3>{i.title}</h3>
                <p>{i.body}</p>
                <span className="evidence-count">{i.evidence}</span>
                <button className="button secondary" type="button" onClick={() => jeff.openModal(<DemoInsightModal i={i} onPrepare={prepare} />)}>
                  Review opportunity <Icon name="arrowUpRight" />
                </button>
              </article>
            ))
          : findings.map((f) => (
              <article className="insight-card" key={f.id}>
                <span className="mini-eyebrow">{CATEGORY_LABEL[f.category] ?? f.category.toUpperCase()}</span>
                <h3>{f.title}</h3>
                <p>{f.interpretation ?? "No interpretation recorded."}</p>
                <span className="evidence-count">
                  {f.evidence.length} evidence item{f.evidence.length === 1 ? "" : "s"} · {f.severity} · {f.status}
                </span>
                <button className="button secondary" type="button" onClick={() => jeff.openModal(<FindingModal f={f} onPrepare={prepare} />)}>
                  Review finding <Icon name="arrowUpRight" />
                </button>
              </article>
            ))}
      </div>
      {!demo && !findings.length ? (
        <EmptyState icon="sun" title="No findings yet.">
          Findings appear after connected sources sync and monitors run. Connect Google, HighLevel, Stripe, or Financial Accounts to start.
        </EmptyState>
      ) : null}
    </section>
  );
}

function DemoInsightModal({ i, onPrepare }: { i: DemoInsight; onPrepare: (goal: string, title?: string) => Promise<void> }) {
  const jeff = useJeff();
  const refs = jeff
    .docs()
    .filter((d) => d.source === i.source)
    .slice(0, 2);
  return (
    <>
      <ModalHeader title={i.title} desc="From evidence to a bounded, reviewable next step." eyebrow="ILLUSTRATIVE OPERATIONAL INSIGHT" />
      <div className="modal-body">
        <div className="callout">
          <strong>Example, not an account finding.</strong> All supporting records below are sample data.
        </div>
        <p className="detail-content">{i.body}</p>
        <div className="section-label">SUPPORTING SAMPLE CONTEXT</div>
        {refs.length ? refs.map((r) => <MemoryRow key={r.id} d={r} />) : <p className="muted">Add the sample source to see example records.</p>}
        <div className="section-label">PROPOSED TASK</div>
        <div className="detail-box">
          <strong>{i.goal}</strong>
        </div>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Close
          </button>
          <button className="button primary" type="button" onClick={() => onPrepare(i.goal, i.title)}>
            <Icon name="compose" />
            Prepare a task draft
          </button>
        </div>
      </div>
    </>
  );
}

function FindingModal({ f, onPrepare }: { f: FindingItem; onPrepare: (goal: string, title?: string) => Promise<void> }) {
  const jeff = useJeff();
  const [status, setStatus] = useState(f.status);
  async function setFindingStatus(s: string) {
    const res = await fetch(`/api/findings/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: s }) });
    if (!res.ok) return jeff.toast("Could not update the finding.");
    setStatus(s);
    jeff.toast("Finding updated.");
  }
  return (
    <>
      <ModalHeader title={f.title} desc={`${CATEGORY_LABEL[f.category] ?? f.category} · severity ${f.severity}`} eyebrow="OPERATIONS FINDING" />
      <div className="modal-body">
        <div className="section-label">OBSERVED FACTS</div>
        <ul className="checklist">
          {f.observedFacts.length ? f.observedFacts.map((x, i) => <li key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</li>) : <li>None recorded.</li>}
        </ul>
        <div className="section-label">CALCULATED METRICS</div>
        <div className="diff-preview">{Object.keys(f.metrics).length ? JSON.stringify(f.metrics, null, 2) : "None."}</div>
        <div className="section-label">AI INTERPRETATION</div>
        <p className="detail-content">{f.interpretation ?? "—"}</p>
        <dl className="kv">
          <dt>Date range</dt>
          <dd>
            {f.rangeStart ? new Date(f.rangeStart).toLocaleDateString() : "—"} → {f.rangeEnd ? new Date(f.rangeEnd).toLocaleDateString() : "—"}
          </dd>
          <dt>Confidence</dt>
          <dd>{f.confidence != null ? `${Math.round(f.confidence * 100)}%` : "—"}</dd>
          <dt>Limitations</dt>
          <dd>{f.limitations ?? "—"}</dd>
          <dt>Status</dt>
          <dd>{status}</dd>
        </dl>
        {f.evidence.length ? (
          <>
            <div className="section-label">EVIDENCE</div>
            <ul className="checklist">
              {f.evidence.map((e, i) => (
                <li key={i}>
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noopener noreferrer">
                      {e.title ?? e.url}
                    </a>
                  ) : (
                    (e.title ?? e.source_item_id ?? "record")
                  )}{" "}
                  {e.provider ? <small>({e.provider})</small> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Close
          </button>
          {status === "open" ? (
            <button className="button secondary" type="button" onClick={() => setFindingStatus("acknowledged")}>
              Acknowledge
            </button>
          ) : null}
          {status !== "dismissed" && status !== "resolved" ? (
            <button className="button secondary" type="button" onClick={() => setFindingStatus("dismissed")}>
              Dismiss
            </button>
          ) : null}
          {f.proposedMission?.goal ? (
            <button className="button primary" type="button" onClick={() => onPrepare(f.proposedMission!.goal!, f.proposedMission!.title)}>
              <Icon name="compose" />
              Prepare a task draft
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
