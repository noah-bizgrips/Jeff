"use client";

import { noteAttention } from "@/lib/jeff/attention/client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState, ModalHeader } from "@/components/jeff/shared";
import type { GoalEventRow, GoalMetricRow, GoalRecommendationRow, GoalRow, GoalSnapshotRow } from "@/lib/jeff/goals/store";
import { TRAJECTORY_LABEL, type MetricResult, type Trajectory } from "@/lib/jeff/goals/schema";
import { formatMetricValue, formatTarget } from "@/lib/jeff/goals/metrics";

export interface GoalListItem {
  goal: GoalRow;
  snapshot: GoalSnapshotRow | null;
  metrics: GoalMetricRow[];
}

const TONE: Record<Trajectory, string> = { on_track: "ok", slightly_at_risk: "amber", at_risk: "amber", severely_at_risk: "danger", unknown: "neutral" };
const STATUS_TONE: Record<string, string> = { draft: "neutral", active: "ok", paused: "neutral", achieved: "ok", missed: "danger", archived: "neutral" };

function daysLeft(g: GoalRow): number | null {
  return g.end_date ? Math.max(0, Math.round((Date.parse(g.end_date) - Date.now()) / 86_400_000)) : null;
}

function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
}

function metricOf(item: GoalListItem, key: string | undefined): MetricResult | null {
  return key ? (item.snapshot?.metrics?.[key] ?? null) : null;
}

function primaryOf(item: GoalListItem): GoalMetricRow | null {
  return item.metrics.find((m) => m.is_primary) ?? item.metrics[0] ?? null;
}

export function GoalsView({ initial }: { initial: GoalListItem[] }) {
  const jeff = useJeff();
  const [items, setItems] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);

  async function reload() {
    const res = await fetch("/api/goals", { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as { goals: GoalListItem[] };
    setItems(d.goals);
  }

  async function refreshAll() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/goals/refresh", { method: "POST" });
      const d = (await res.json().catch(() => null)) as { refreshed?: number; changed?: number; error?: string } | null;
      if (!res.ok) return jeff.toast(`Could not refresh goals (${d?.error ?? res.status}).`);
      jeff.toast(`Refreshed ${d?.refreshed ?? 0} goal${d?.refreshed === 1 ? "" : "s"} · ${d?.changed ?? 0} trajectory change${d?.changed === 1 ? "" : "s"}.`);
      await reload();
    } finally {
      setRefreshing(false);
    }
  }

  const active = items.filter((i) => ["active", "paused"].includes(i.goal.status));
  const drafts = items.filter((i) => i.goal.status === "draft");
  const done = items.filter((i) => ["achieved", "missed", "archived"].includes(i.goal.status));

  return (
    <section className="page-view" id="goalsView">
      <div className="preview-banner">
        <Icon name="target" />
        <span>
          <strong>Goals are measured, not asserted.</strong> Every metric shows its source, formula and freshness. Trajectory labels avoid fake precision. Nothing counts until you approve the definition.
        </span>
      </div>
      <div className="view-toolbar">
        <p>{active.length ? `${active.length} active goal${active.length === 1 ? "" : "s"}` : "No active goals yet."}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="button secondary" type="button" disabled={refreshing || !active.length} onClick={refreshAll}>
            {refreshing ? <span className="spinner" /> : <Icon name="refresh" />}
            Refresh now
          </button>
          <button className="button primary" type="button" onClick={() => jeff.openModal(<NewGoalModal onCreated={reload} />)}>
            <Icon name="plus" />
            New goal
          </button>
        </div>
      </div>

      {drafts.length ? (
        <>
          <div className="section-label">DRAFTS — REVIEW & APPROVE</div>
          <div className="goal-grid">
            {drafts.map((it) => (
              <GoalCard key={it.goal.id} item={it} onOpen={() => jeff.openModal(<GoalReviewModal goalId={it.goal.id} onChanged={reload} />)} />
            ))}
          </div>
        </>
      ) : null}

      <div className="section-label">ACTIVE</div>
      <div className="goal-grid">
        {active.length ? (
          active.map((it) => <GoalCard key={it.goal.id} item={it} onOpen={() => jeff.openModal(<GoalDetailModal goalId={it.goal.id} onChanged={reload} />)} />)
        ) : (
          <EmptyState icon="target" title="Tell Jeff what you're aiming for.">
            Type a goal in plain language — Jeff turns it into metrics with sources, lists its assumptions, and asks about anything ambiguous before tracking begins.
          </EmptyState>
        )}
      </div>

      {done.length ? (
        <>
          <div className="section-label">COMPLETED / ARCHIVED</div>
          <div className="goal-grid">
            {done.map((it) => (
              <GoalCard key={it.goal.id} item={it} onOpen={() => jeff.openModal(<GoalDetailModal goalId={it.goal.id} onChanged={reload} />)} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function GoalCard({ item, onOpen }: { item: GoalListItem; onOpen: () => void }) {
  const g = item.goal;
  const primary = primaryOf(item);
  const p = metricOf(item, primary?.key);
  const traj = item.snapshot?.trajectory ?? "unknown";
  const pct = item.snapshot?.completion_pct ?? null;
  const left = daysLeft(g);
  const unresolved = g.ambiguities.filter((a) => !a.resolution).length;
  return (
    <article className="goal-card">
      <div className="mission-card-top">
        <span className="mission-code">{g.scope.toUpperCase()}</span>
        {g.status === "draft" ? <span className="pill neutral">Draft · {unresolved} to resolve</span> : g.status === "active" ? <span className={`pill ${TONE[traj]}`}>{TRAJECTORY_LABEL[traj]}</span> : <span className={`pill ${STATUS_TONE[g.status] ?? "neutral"}`}>{g.status}</span>}
      </div>
      <h3>{g.name}</h3>
      {primary ? (
        <div className="goal-progress">
          <div className="goal-progress-head">
            <strong>{p ? formatMetricValue(p) : primary.current_value == null ? "—" : String(primary.current_value)}</strong>
            <span className="muted">{formatTarget({ target: primary.target_value == null ? null : Number(primary.target_value), comparator: primary.comparator, kind: primary.kind, unit: primary.unit ?? "", target_upper: primary.target_upper == null ? null : Number(primary.target_upper) })}</span>
          </div>
          <div className="goal-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
          </div>
        </div>
      ) : null}
      <p className="muted" style={{ fontSize: 11 }}>
        {left != null ? `${left} days remaining` : g.status === "draft" ? "Timeframe set on approval" : "No deadline"}
        {item.snapshot?.constraint_key ? ` · constraint: ${item.snapshot.constraint_key.replace(/_/g, " ")}` : ""}
        {p?.freshness === "stale" ? " · data stale" : p?.freshness === "missing" ? " · source missing" : ""}
      </p>
      <div className="mission-card-footer">
        <button className="button secondary" type="button" onClick={onOpen}>
          {g.status === "draft" ? "Review & approve" : "Open"} <Icon name="arrowUpRight" />
        </button>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* New goal                                                            */
/* ------------------------------------------------------------------ */

function NewGoalModal({ onCreated }: { onCreated: () => Promise<void> }) {
  const jeff = useJeff();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
      const d = (await res.json().catch(() => null)) as { goal?: GoalRow; notes?: string[]; error?: string } | null;
      if (!res.ok || !d?.goal) return jeff.toast(`Could not interpret the goal (${d?.error ?? res.status}).`);
      await onCreated();
      setCreated(d.goal.id);
      if (d.notes?.length) jeff.toast(d.notes[0]!);
    } finally {
      setBusy(false);
    }
  }

  if (created) return <GoalReviewModal goalId={created} onChanged={onCreated} />;
  return (
    <>
      <ModalHeader title="What are you aiming for?" desc="Write it the way you'd say it. Jeff proposes the metrics, sources and assumptions — you approve them." eyebrow="NEW GOAL" />
      <form className="modal-body form-grid" onSubmit={submit}>
        <label className="field">
          Goal
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={2000} required placeholder="Onboard 10 new clients in the next 60 days with a CAC under $1,000 and a sign date to first payment date in under 14 days." />
        </label>
        <div className="callout">Jeff will not track anything until you review the interpretation. Ambiguous definitions (what counts as a client, which spend is CAC…) are asked, not assumed.</div>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy || prompt.trim().length < 8}>
            {busy ? <span className="spinner" /> : <Icon name="sparkles" />}
            Interpret
          </button>
        </div>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Review / approve draft                                              */
/* ------------------------------------------------------------------ */

interface GoalDetail {
  goal: GoalRow;
  metrics: GoalMetricRow[];
  snapshots: GoalSnapshotRow[];
  latest: GoalSnapshotRow | null;
  events: GoalEventRow[];
  recommendations: GoalRecommendationRow[];
  missions: { id: string; code: string; title: string; status: string; created_at: string }[];
}

function useGoalDetail(goalId: string) {
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/goals/${goalId}`, { cache: "no-store" });
    if (!res.ok) {
      setError(`Could not load the goal (${res.status}).`);
      return;
    }
    const d = (await res.json()) as GoalDetail;
    setDetail(d);
  }, [goalId]);
  useEffect(() => {
    noteAttention({ kind: "goal_viewed", ref_id: goalId });
    // Fetch on mount; state updates happen in the async callback, not synchronously in the effect.
    fetch(`/api/goals/${goalId}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as GoalDetail;
      })
      .then((d) => setDetail(d))
      .catch((e: Error) => setError(`Could not load the goal (${e.message}).`));
  }, [goalId]);
  return { detail, error, reload: load };
}

function targetOfRow(m: GoalMetricRow) {
  return formatTarget({ target: m.target_value == null ? null : Number(m.target_value), comparator: m.comparator, kind: m.kind, unit: m.unit ?? "", target_upper: m.target_upper == null ? null : Number(m.target_upper) });
}

function sourcesOfRow(m: GoalMetricRow): string {
  const inputs = Object.values(m.source_mappings ?? {});
  if (!inputs.length) return "not mapped yet";
  return inputs.map((i) => `${i.provider} ${i.resource_type}`).join(" + ");
}

function GoalReviewModal({ goalId, onChanged }: { goalId: string; onChanged: () => Promise<void> }) {
  const jeff = useJeff();
  const { detail, error, reload } = useGoalDetail(goalId);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [name, setName] = useState<string | null>(null);
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [busy, setBusy] = useState(false);

  if (error) return <ModalHeader title="Goal" desc={error} eyebrow="ERROR" />;
  if (!detail) return <ModalHeader title="Loading…" eyebrow="GOAL" />;
  const g = detail.goal;
  const unresolved = g.ambiguities.filter((a) => !(resolutions[a.field] ?? a.resolution));

  async function approve() {
    setBusy(true);
    try {
      const res = await fetch(`/api/goals/${goalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approve: { resolutions, name: name ?? undefined, start_date: start || undefined, end_date: end || undefined } }),
      });
      const d = (await res.json().catch(() => null)) as { error?: string; fields?: string[] } | null;
      if (!res.ok) return jeff.toast(`Could not approve (${d?.error ?? res.status}${d?.fields?.length ? `: ${d.fields.join(", ")}` : ""}).`);
      jeff.toast("Goal approved. Jeff is tracking it now.");
      await onChanged();
      jeff.closeModal();
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!confirm("Delete this draft goal?")) return;
    const res = await fetch(`/api/goals/${goalId}`, { method: "DELETE" });
    if (!res.ok) return jeff.toast("Could not delete the draft.");
    await onChanged();
    jeff.closeModal();
  }

  return (
    <>
      <ModalHeader title={name ?? g.name} desc={`"${g.prompt_text}"`} eyebrow="DRAFT GOAL · REVIEW BEFORE TRACKING" />
      <div className="modal-body">
        <div className="form-grid">
          <label className="field">
            Name
            <input value={name ?? g.name} onChange={(e) => setName(e.target.value)} maxLength={140} />
          </label>
          <div className="goal-two-col">
            <label className="field">
              Start date
              <input type="date" value={start || g.start_date || ""} onChange={(e) => setStart(e.target.value)} />
              <small>Defaults to today.</small>
            </label>
            <label className="field">
              End date
              <input type="date" value={end || g.end_date || ""} onChange={(e) => setEnd(e.target.value)} />
              <small>{g.interpretation.timeframe.days ? `Defaults to start + ${g.interpretation.timeframe.days} days.` : "Leave empty to track continuously."}</small>
            </label>
          </div>
        </div>

        <div className="section-label">METRICS JEFF WILL TRACK</div>
        <div className="goal-metric-table">
          {detail.metrics.map((m) => (
            <div className="policy-row" key={m.id}>
              <div>
                <strong>
                  {m.name} {m.is_primary ? <span className="pill info">primary</span> : m.is_constraint ? <span className="pill neutral">constraint</span> : null}
                </strong>
                <small>
                  Target {targetOfRow(m)} · source: {sourcesOfRow(m)}
                  {m.formula ? ` · formula: ${m.formula}` : ""}
                  {m.limitations ? ` · ${m.limitations}` : ""}
                </small>
              </div>
            </div>
          ))}
        </div>

        {g.assumptions.length ? (
          <>
            <div className="section-label">ASSUMPTIONS</div>
            <ul className="checklist">
              {g.assumptions.map((a, i) => (
                <li key={i}>
                  <Icon name="info" />
                  {a}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {g.ambiguities.length ? (
          <>
            <div className="section-label">RESOLVE BEFORE APPROVING</div>
            <div className="form-grid">
              {g.ambiguities.map((a) => (
                <div className="field" key={a.field}>
                  {a.question}
                  <div className="goal-options">
                    {a.options.map((o) => (
                      <label key={o} className={`goal-option ${(resolutions[a.field] ?? a.resolution) === o ? "selected" : ""}`}>
                        <input type="radio" name={a.field} checked={(resolutions[a.field] ?? a.resolution) === o} onChange={() => setResolutions((r) => ({ ...r, [a.field]: o }))} />
                        <span>{o}</span>
                      </label>
                    ))}
                  </div>
                  <input placeholder="Or type your own definition…" maxLength={400} value={a.options.includes(resolutions[a.field] ?? "") ? "" : (resolutions[a.field] ?? "")} onChange={(e) => setResolutions((r) => ({ ...r, [a.field]: e.target.value }))} />
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Later
          </button>
          <button className="button secondary danger-button" type="button" onClick={discard}>
            <Icon name="trash" />
            Discard draft
          </button>
          <button className="button primary" type="button" disabled={busy || unresolved.length > 0} onClick={approve} title={unresolved.length ? `${unresolved.length} question${unresolved.length === 1 ? "" : "s"} still open` : undefined}>
            {busy ? <span className="spinner" /> : <Icon name="check" />}
            Approve & start tracking
          </button>
        </div>
        <p className="auth-note">
          <button type="button" className="text-button" onClick={reload}>
            Reload
          </button>
        </p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Active goal detail                                                  */
/* ------------------------------------------------------------------ */

function GoalDetailModal({ goalId, onChanged }: { goalId: string; onChanged: () => Promise<void> }) {
  const jeff = useJeff();
  const { detail, error, reload } = useGoalDetail(goalId);
  const [busy, setBusy] = useState(false);

  if (error) return <ModalHeader title="Goal" desc={error} eyebrow="ERROR" />;
  if (!detail) return <ModalHeader title="Loading…" eyebrow="GOAL" />;
  const g = detail.goal;
  const latest = detail.latest;
  const traj = latest?.trajectory ?? "unknown";
  const primary = detail.metrics.find((m) => m.is_primary) ?? detail.metrics[0] ?? null;
  const left = daysLeft(g);

  async function act(action: "pause" | "resume" | "archive") {
    setBusy(true);
    try {
      const res = await fetch(`/api/goals/${goalId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      if (!res.ok) return jeff.toast("Could not update the goal.");
      await Promise.all([reload(), onChanged()]);
      jeff.toast(`Goal ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "archived"}.`);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      const res = await fetch(`/api/goals/${goalId}/refresh`, { method: "POST" });
      if (!res.ok) return jeff.toast("Could not refresh the goal.");
      await Promise.all([reload(), onChanged()]);
      jeff.toast("Goal refreshed.");
    } finally {
      setBusy(false);
    }
  }

  async function prepare(rec: GoalRecommendationRow) {
    setBusy(true);
    try {
      const res = await fetch(`/api/goals/${goalId}/recommendations/${rec.id}/prepare`, { method: "POST" });
      const d = (await res.json().catch(() => null)) as { mission?: { code: string } } | null;
      if (!res.ok || !d?.mission) return jeff.toast("Could not prepare the mission.");
      jeff.toast(`Mission ${d.mission.code} drafted. Nothing runs until you approve it.`);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const history = detail.snapshots.slice(-12);
  const drivers = g.interpretation.drivers ?? [];

  return (
    <>
      <ModalHeader title={g.name} desc={`"${g.prompt_text}"`} eyebrow={`${g.scope.toUpperCase()} GOAL · ${g.status.toUpperCase()}`} />
      <div className="modal-body">
        <div className="task-detail-grid">
          <div className="detail-box">
            <small>Trajectory</small>
            <strong>
              <span className={`pill ${TONE[traj]}`}>{TRAJECTORY_LABEL[traj]}</span>
            </strong>
          </div>
          <div className="detail-box">
            <small>Progress</small>
            <strong>{latest?.completion_pct != null ? `${latest.completion_pct}%` : "—"}</strong>
          </div>
          <div className="detail-box">
            <small>Time</small>
            <strong>
              {latest?.elapsed_pct != null ? `${latest.elapsed_pct}% elapsed` : "—"}
              {left != null ? ` · ${left}d left` : ""}
            </strong>
          </div>
          <div className="detail-box">
            <small>Pace (per day)</small>
            <strong>
              {latest?.observed_pace != null ? `${latest.observed_pace} observed` : "—"}
              {latest?.required_pace != null ? ` / ${latest.required_pace} required` : ""}
            </strong>
          </div>
        </div>
        {latest?.forecast?.value != null ? (
          <p className="detail-content">
            Forecast at {fmtDate(latest.forecast.at)}: <strong>{latest.forecast.value}</strong>
            {latest.forecast.low != null && latest.forecast.high != null && latest.forecast.low !== latest.forecast.high ? ` (roughly ${latest.forecast.low}–${latest.forecast.high})` : ""} · {latest.forecast.basis}.
          </p>
        ) : null}
        {latest?.constraint_key ? (
          <div className="callout">
            <strong>Primary constraint:</strong> {latest.constraint_key.replace(/_/g, " ")}
            {detail.events.find((e) => e.kind === "trajectory_changed")?.payload?.constraint ? ` — ${String(detail.events.find((e) => e.kind === "trajectory_changed")!.payload.constraint)}` : ""}
          </div>
        ) : null}

        <div className="section-label">METRICS</div>
        <div className="goal-metric-table">
          {detail.metrics.map((m) => {
            const r = latest?.metrics?.[m.key];
            return (
              <div className="policy-row" key={m.id}>
                <div>
                  <strong>
                    {m.name} {m.is_primary ? <span className="pill info">primary</span> : null}
                  </strong>
                  <small>
                    {r ? `${r.source} · ${r.formula || "direct"} · ${r.time_range ? `${fmtDate(r.time_range.start)} → ${fmtDate(r.time_range.end)}` : ""} · n=${r.sample_size} · updated ${r.last_updated ? fmtDate(r.last_updated) : "never"}` : sourcesOfRow(m)}
                    {r?.limitations?.length ? ` · ${r.limitations.join(" ")}` : ""}
                  </small>
                </div>
                <div style={{ textAlign: "right" }}>
                  <strong>{r ? formatMetricValue(r) : "—"}</strong>
                  <br />
                  <small className="muted">{targetOfRow(m)}</small>
                  <br />
                  <span className={`pill ${r?.freshness === "fresh" ? (r.meets_target === false ? "amber" : "ok") : r?.freshness === "stale" ? "amber" : "neutral"}`}>{r ? (r.freshness === "missing" ? "source missing" : r.meets_target == null ? r.freshness : r.meets_target ? "meets target" : "off target") : "not computed"}</span>
                </div>
              </div>
            );
          })}
        </div>

        {drivers.length ? (
          <>
            <div className="section-label">LEADING INDICATORS</div>
            <ul className="checklist">
              {drivers.map((d) => (
                <li key={d.key}>
                  <Icon name={latest?.constraint_key === d.key ? "info" : "check"} />
                  {d.name}
                  {d.implied_target != null ? ` · implied ${d.implied_target} over the window` : ""}
                  {d.assumption ? <small className="muted"> — {d.assumption}</small> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {history.length > 1 && primary ? (
          <>
            <div className="section-label">HISTORY</div>
            <div className="goal-history">
              {history.map((s) => {
                const v = s.metrics?.[primary.key]?.value ?? null;
                const t = primary.target_value == null ? null : Number(primary.target_value);
                const h = v != null && t ? Math.max(4, Math.min(100, (v / t) * 100)) : 4;
                return <span key={s.id} title={`${fmtDate(s.taken_at)}: ${v ?? "—"} · ${TRAJECTORY_LABEL[s.trajectory]}`} className={`goal-history-bar ${TONE[s.trajectory]}`} style={{ height: `${h}%` }} />;
              })}
            </div>
          </>
        ) : null}

        {detail.recommendations.filter((r) => r.status !== "dismissed").length ? (
          <>
            <div className="section-label">JEFF RECOMMENDS</div>
            {detail.recommendations
              .filter((r) => r.status !== "dismissed")
              .map((r) => (
                <article className="insight-card" key={r.id} style={{ marginBottom: 10 }}>
                  <span className="mini-eyebrow">{r.requires_approval ? "REQUIRES APPROVAL TO ACT" : "READ-ONLY ANALYSIS"}</span>
                  <h3>{r.title}</h3>
                  <p>
                    <strong>Why:</strong> {r.why}
                  </p>
                  {r.mechanism ? (
                    <p>
                      <strong>Mechanism:</strong> {r.mechanism}
                    </p>
                  ) : null}
                  {r.downside ? (
                    <p>
                      <strong>Downside:</strong> {r.downside}
                    </p>
                  ) : null}
                  {r.jeff_can_prepare ? (
                    <p>
                      <strong>Jeff can prepare:</strong> {r.jeff_can_prepare}
                    </p>
                  ) : null}
                  {r.status === "prepared" && r.mission_id ? (
                    <Link className="button secondary" href="/missions">
                      View mission <Icon name="arrowUpRight" />
                    </Link>
                  ) : (
                    <button className="button secondary" type="button" disabled={busy} onClick={() => prepare(r)}>
                      <Icon name="compose" />
                      Prepare
                    </button>
                  )}
                </article>
              ))}
          </>
        ) : null}

        {detail.missions.length ? (
          <>
            <div className="section-label">RELATED MISSIONS</div>
            <ul className="checklist">
              {detail.missions.map((m) => (
                <li key={m.id}>
                  <Icon name="compose" />
                  {m.code} · {m.title} · {m.status}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="section-label">HISTORY & EVENTS</div>
        <div className="audit-list">
          {detail.events.slice(0, 8).map((e) => (
            <div className="audit-row" key={e.id}>
              <Icon name="lock" />
              <div>
                <strong>{e.kind.replace(/_/g, " ")}</strong>
                <p>{describeEvent(e)}</p>
              </div>
              <span>{fmtDate(e.created_at)}</span>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Close
          </button>
          <button className="button secondary" type="button" disabled={busy} onClick={refresh}>
            <Icon name="refresh" />
            Refresh
          </button>
          {g.status === "active" ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => act("pause")}>
              Pause
            </button>
          ) : g.status === "paused" ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => act("resume")}>
              Resume
            </button>
          ) : null}
          {g.status !== "archived" ? (
            <button className="button secondary danger-button" type="button" disabled={busy} onClick={() => act("archive")}>
              Archive
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function describeEvent(e: GoalEventRow): string {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "trajectory_changed":
      return `${String(p.from ?? "—")} → ${String(p.to ?? "—")}${Array.isArray(p.reasons) && p.reasons.length ? ` · ${String(p.reasons[0])}` : ""}`;
    case "approved":
      return `Approved · ${String(p.start_date ?? "")} → ${String(p.end_date ?? "open-ended")}`;
    case "metric_updated":
      return Object.entries((p.values as Record<string, unknown>) ?? {})
        .map(([k, v]) => `${k}: ${v ?? "—"}`)
        .join(", ");
    case "edited":
      return p.status ? `Status → ${String(p.status)}` : `Changed ${Object.keys((p.after as object) ?? {}).join(", ") || "definition"}`;
    case "note":
      return String(p.note ?? p.mission ?? "");
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 140) : "";
  }
}
