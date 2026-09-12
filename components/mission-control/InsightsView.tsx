"use client";

import { useState } from "react";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState, MemoryRow, ModalHeader } from "@/components/jeff/shared";
import type { DemoInsight } from "@/lib/jeff/demo-data";
import { RuleEditor } from "@/components/memory/MemoryRulesView";
import type { RuleAction, RuleCondition } from "@/lib/jeff/rules/schema";

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
  suppressedByRuleId?: string | null;
  suppressedByRuleName?: string | null;
}

/** Narrow rule proposal returned by the feedback endpoint (matches RuleEditor's `proposed` prop). */
interface RuleProposal {
  name: string;
  description?: string;
  target_monitor: string | null;
  conditions: RuleCondition;
  action: RuleAction;
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
  underperforming_acquisition: "ACQUISITION EFFICIENCY",
  operational_bottleneck: "OPERATIONS",
  automation_opportunity: "AUTOMATION OPPORTUNITY",
};

export function rowToFinding(f: Record<string, unknown>): FindingItem {
  return {
    id: String(f.id),
    category: String(f.category),
    title: String(f.title),
    observedFacts: (f.observed_facts as unknown[]) ?? [],
    metrics: (f.metrics as Record<string, unknown>) ?? {},
    interpretation: (f.interpretation as string | null) ?? null,
    evidence: (f.evidence as FindingItem["evidence"]) ?? [],
    rangeStart: (f.range_start as string | null) ?? null,
    rangeEnd: (f.range_end as string | null) ?? null,
    confidence: (f.confidence as number | null) ?? null,
    limitations: (f.limitations as string | null) ?? null,
    severity: String(f.severity ?? "info"),
    status: String(f.status ?? "open"),
    proposedMission: (f.proposed_mission as FindingItem["proposedMission"]) ?? null,
    createdAt: String(f.created_at ?? ""),
    isSample: Boolean(f.is_sample),
    suppressedByRuleId: (f.suppressed_by_rule_id as string | null) ?? null,
    suppressedByRuleName: ((f.operating_rules as { name?: string } | null | undefined)?.name as string | undefined) ?? null,
  };
}

export function InsightsView({ findings: initialFindings, demoInsights, liveMonitors }: { findings: FindingItem[]; demoInsights: DemoInsight[]; liveMonitors: number }) {
  const jeff = useJeff();
  const demo = jeff.mode === "demo";
  const [findings, setFindings] = useState(initialFindings);
  const [running, setRunning] = useState(false);

  async function runMonitors() {
    setRunning(true);
    try {
      const res = await fetch("/api/monitors/run", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { created?: number; updated?: number; resolved?: number; candidates?: number; error?: string } | null;
      if (!res.ok || !data) return jeff.toast(`Monitors could not run (${data?.error ?? res.status}).`);
      jeff.toast(`Monitors ran: ${data.candidates ?? 0} findings (${data.created ?? 0} new, ${data.updated ?? 0} updated, ${data.resolved ?? 0} resolved).`);
      const list = await fetch("/api/findings", { cache: "no-store" });
      const body = (await list.json().catch(() => null)) as { findings?: Record<string, unknown>[] } | null;
      if (list.ok && body?.findings) setFindings(body.findings.map(rowToFinding));
    } finally {
      setRunning(false);
    }
  }

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
      {!demo ? (
        <div className="view-toolbar">
          <p>Monitors re-run automatically after every scheduled sync. Run them now to re-check against the latest synced data.</p>
          <button className="button primary" type="button" disabled={running} onClick={runMonitors}>
            {running ? <span className="spinner" /> : <Icon name="refresh" />}
            Run monitors now
          </button>
        </div>
      ) : null}
      <div className="metric-grid">
        <div className="metric-box">
          <small>Live monitors</small>
          <strong>{liveMonitors}</strong>
          <p>{liveMonitors ? "Run after every sync" : "Enabled after sources sync"}</p>
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
          : findings.filter((f) => f.status !== "suppressed_by_rule").map((f) => (
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
      {!demo && findings.some((f) => f.status === "suppressed_by_rule") ? (
        <details className="callout" style={{ marginTop: 16 }}>
          <summary>
            Suppressed by your rules ({findings.filter((f) => f.status === "suppressed_by_rule").length}) — kept for history, hidden from the active monitor
          </summary>
          <div className="audit-list" style={{ marginTop: 8 }}>
            {findings
              .filter((f) => f.status === "suppressed_by_rule")
              .map((f) => (
                <div className="audit-row" key={f.id}>
                  <Icon name="lock" />
                  <div>
                    <strong>{f.title}</strong>
                    <p>
                      {CATEGORY_LABEL[f.category] ?? f.category}
                      {f.suppressedByRuleName ? ` · rule: ${f.suppressedByRuleName}` : ""}
                    </p>
                  </div>
                  <button className="button secondary" type="button" onClick={() => jeff.openModal(<FindingModal f={f} onPrepare={prepare} />)}>
                    View
                  </button>
                </div>
              ))}
          </div>
        </details>
      ) : null}
      {!demo && !findings.some((f) => f.status !== "suppressed_by_rule") ? (
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
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  async function feedback(verdict: "useful" | "not_useful" | "wrong" | "too_noisy" | "dont_show" | "change_rule") {
    setFeedbackBusy(true);
    try {
      const res = await fetch(`/api/findings/${f.id}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verdict }) });
      const d = (await res.json().catch(() => null)) as { rule?: { name: string }; suppressed?: number; proposed?: RuleProposal | null; error?: string } | null;
      if (!res.ok) return jeff.toast(`Could not record feedback (${d?.error ?? res.status}).`);
      if (verdict === "dont_show") {
        if (d?.rule) {
          setStatus("suppressed_by_rule");
          jeff.toast(`Rule added: "${d.rule.name}" · ${d.suppressed ?? 0} finding(s) suppressed. Review under Memory & rules.`);
          jeff.closeModal();
        } else {
          setStatus("dismissed");
          jeff.toast("Dismissed. No safe narrow rule could be inferred from this finding's evidence.");
        }
        return;
      }
      if (verdict === "change_rule" || verdict === "too_noisy") {
        if (d?.proposed) {
          jeff.openModal(<RuleEditor proposed={d.proposed} onSaved={async () => {}} />);
          return;
        }
        jeff.toast("Feedback recorded. No narrow rule could be proposed from this finding's evidence — add one under Memory & rules.");
        return;
      }
      if (verdict === "useful") setStatus("accepted");
      if (verdict === "wrong" || verdict === "not_useful") setStatus("dismissed");
      jeff.toast("Thanks — feedback recorded.");
    } finally {
      setFeedbackBusy(false);
    }
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
        <div className="section-label">WAS THIS USEFUL?</div>
        <div className="connection-actions" style={{ flexWrap: "wrap" }}>
          {(
            [
              ["useful", "Useful"],
              ["not_useful", "Not useful"],
              ["wrong", "Wrong"],
              ["too_noisy", "Too noisy"],
              ["dont_show", "Don't show this again"],
              ["change_rule", "Change rule"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="button secondary" type="button" disabled={feedbackBusy} onClick={() => feedback(v)}>
              {label}
            </button>
          ))}
        </div>
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
