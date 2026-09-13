"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { sourcesForJob } from "@/lib/jeff/brain/sources";
import { ModalHeader } from "@/components/jeff/shared";
import { RuleEditor } from "@/components/memory/MemoryRulesView";
import type { PresentedRule } from "@/lib/jeff/rules/present";
import type { RuleAction, RuleCondition } from "@/lib/jeff/rules/schema";
import { TestModePanel } from "./TestModePanel";
import { api, fmtWhen, SOURCE_LABEL, STATUS_TONE, type JobFinding, type JobItem, type JobRunRow, type RunOutcome } from "./types";

const SEVERITY_TONE: Record<string, string> = { high: "danger", medium: "amber", low: "neutral", info: "info" };
const RUN_TONE: Record<string, string> = { succeeded: "ok", partial: "amber", failed: "danger", running: "info", queued: "neutral" };

interface RuleProposal {
  name: string;
  description?: string;
  target_monitor: string | null;
  conditions: RuleCondition;
  action: RuleAction;
}

/** One job, every section from spec §6.2. Actions are Tier 1 (reversible configuration); runs go through the same runner as the cron. */
export function JobDetailView({ initialJob, initialRuns, obligations = null }: { initialJob: JobItem; initialRuns: JobRunRow[]; obligations?: { live: number; overdue: number; waiting_on_me: number; waiting_on_other: number; possibly_complete: number; snoozed: number } | null }) {
  const jeff = useJeff();
  const [job, setJob] = useState(initialJob);
  const [runs, setRuns] = useState(initialRuns);
  const [findings, setFindings] = useState<JobFinding[] | null>(null);
  const [rules, setRules] = useState<PresentedRule[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [j, f, r] = await Promise.all([
      api<{ job: JobItem; runs: JobRunRow[] }>(`/api/jobs/${initialJob.slug}`),
      api<{ findings: JobFinding[] }>(`/api/jobs/${initialJob.slug}/findings?status=all&limit=40`),
      api<{ rules: PresentedRule[] }>("/api/rules"),
    ]);
    if (j.ok && j.data) {
      setJob(j.data.job);
      setRuns(j.data.runs);
    }
    if (f.ok && f.data) setFindings(f.data.findings);
    if (r.ok && r.data) setRules(r.data.rules.filter((x) => x.target_job === initialJob.slug));
  }, [initialJob.slug]);

  useEffect(() => {
    // Fetch on mount; state updates happen in the async callback, not synchronously in the effect.
    const t = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t);
  }, [reload]);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const res = await api<{ job: JobItem }>(`/api/jobs/${job.slug}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok || !res.data) return jeff.toast(`Could not update (${res.error ?? res.status}).`);
      setJob(res.data.job);
      jeff.toast(`${job.ui_name}: ${label}.`);
    } finally {
      setBusy(null);
    }
  }

  // While a run/test is in flight the brain shows the job's declared sources being examined; afterwards it re-reads state.
  function jobStarted() {
    jeff.setBrainActivity({ kind: "job", sources: sourcesForJob(job.sources, jeff.connectedSources()) });
  }
  function jobFinished() {
    jeff.setBrainActivity({ kind: null, sources: [] });
    void jeff.refreshBrain({ force: true });
  }

  async function test() {
    setBusy("test");
    jobStarted();
    try {
      const res = await api<RunOutcome>(`/api/jobs/${job.slug}/test`, { method: "POST" });
      if (!res.ok || !res.data) return jeff.toast(`Test failed (${res.error ?? res.status}).`);
      jeff.openModal(<TestModePanel job={job} outcome={res.data} onRuleSaved={reload} />);
      await reload();
    } finally {
      setBusy(null);
      jobFinished();
    }
  }

  async function runNow() {
    setBusy("run");
    jobStarted();
    try {
      const res = await api<RunOutcome>(`/api/jobs/${job.slug}/run`, { method: "POST" });
      if (!res.ok || !res.data) return jeff.toast(`Run failed (${res.error ?? res.status}).`);
      const s = res.data.stats;
      jeff.toast(`Run ${res.data.status}: ${s.findings_created ?? 0} new · ${s.findings_updated ?? 0} updated · ${s.findings_resolved ?? 0} resolved · ${s.alerts_created ?? 0} alerts.`);
      await reload();
    } finally {
      setBusy(null);
      jobFinished();
    }
  }

  async function remove() {
    if (!confirm(`Delete “${job.name}”? Its findings stay; the job and its history are removed.`)) return;
    const res = await api<{ ok: boolean }>(`/api/jobs/${job.slug}`, { method: "DELETE" });
    if (!res.ok) return jeff.toast(`Could not delete (${res.error ?? res.status}).`);
    jeff.toast("Job deleted.");
    jeff.navigate("/jobs");
  }

  const lastRun = runs[0] ?? null;
  const policy = job.notification_policy;
  const canRun = job.detectors.length > 0 && job.status !== "disabled";

  return (
    <section className="page-view" id="jobDetailView">
      <div className="view-toolbar">
        <p>
          <Link href="/jobs">Jeff&apos;s Jobs</Link> / {job.ui_name}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="button secondary" type="button" disabled={!!busy || !job.detectors.length} onClick={test} title="Analyse now without creating findings or alerts">
            {busy === "test" ? <span className="spinner" /> : null} Test
          </button>
          <button className="button secondary" type="button" disabled={!!busy || !canRun} onClick={runNow}>
            {busy === "run" ? <span className="spinner" /> : <Icon name="play" />} Run now
          </button>
          {job.status === "active" ? (
            <button className="button secondary" type="button" disabled={!!busy} onClick={() => patch({ status: "paused" }, "paused")}>
              <Icon name="pause" /> Pause
            </button>
          ) : (
            <button className="button secondary" type="button" disabled={!!busy || !job.detectors.length} onClick={() => patch({ status: "active" }, "resumed")}>
              <Icon name="play" /> {job.status === "draft" ? "Activate" : "Resume"}
            </button>
          )}
          <button className="button secondary" type="button" onClick={() => jeff.openModal(<EditJobModal job={job} onSaved={reload} />)}>
            Edit
          </button>
          {job.status !== "disabled" ? (
            <button className="button secondary" type="button" disabled={!!busy} onClick={() => patch({ status: "disabled" }, "disabled")}>
              Disable
            </button>
          ) : null}
          {!job.system_managed ? (
            <button className="button secondary danger" type="button" onClick={remove}>
              <Icon name="trash" /> Delete
            </button>
          ) : null}
        </div>
      </div>

      <div className="job-detail-grid">
        <div className="job-detail-col">
          <div className="section-label">OVERVIEW</div>
          <article className="goal-card">
            <div className="mission-card-top">
              <span className="mission-code">
                {job.icon.length <= 3 ? `${job.icon} ` : ""}
                {job.scope.toUpperCase()} · {job.job_type.toUpperCase()}
              </span>
              <span className={`pill ${STATUS_TONE[job.status_label]}`}>{job.status_label}</span>
            </div>
            <h3>{job.ui_name}</h3>
            <p className="muted">{job.description}</p>
            {job.pending ? <div className="callout">{job.pending}</div> : null}
            <dl className="kv">
              <dt>Runs</dt>
              <dd>{job.run_count}</dd>
              <dt>Findings (30d)</dt>
              <dd>{job.findings_30d}</dd>
              <dt>Last run</dt>
              <dd>{fmtWhen(job.last_run_at)}</dd>
              <dt>Next run</dt>
              <dd>{job.next_run_at ? fmtWhen(job.next_run_at) : job.schedule_type === "manual" ? "manual only" : "not scheduled"}</dd>
            </dl>
          </article>

          {obligations ? (
            <>
              <div className="section-label">OPEN OBLIGATIONS</div>
              <article className="goal-card">
                <div className="metric-grid">
                  {(
                    [
                      ["Open", obligations.live],
                      ["Overdue", obligations.overdue],
                      ["Waiting on me", obligations.waiting_on_me],
                      ["Waiting on someone else", obligations.waiting_on_other],
                      ["Possibly complete", obligations.possibly_complete],
                      ["Snoozed", obligations.snoozed],
                    ] as const
                  ).map(([label, n]) => (
                    <div className="metric-box" key={label}>
                      <small>{label}</small>
                      <strong>{n}</strong>
                    </div>
                  ))}
                </div>
                <Link className="button secondary" href="/follow-through" style={{ marginTop: 10 }}>
                  Open the Follow-Through queue <Icon name="arrowUpRight" />
                </Link>
              </article>
            </>
          ) : null}

          <div className="section-label">PURPOSE</div>
          <article className="goal-card">
            <p>{job.purpose || job.description}</p>
            {job.looks_for.length ? (
              <ul className="test-facts">
                {job.looks_for.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            ) : null}
            {job.detector_labels.length ? (
              <p className="muted" style={{ fontSize: 12 }}>
                Detectors: {job.detector_labels.join(" · ")}
              </p>
            ) : (
              <p className="muted" style={{ fontSize: 12 }}>
                No detectors yet — this analyst is defined but cannot run until its detectors ship.
              </p>
            )}
            {Array.isArray(job.config.limitations) && job.config.limitations.length ? (
              <p className="muted" style={{ fontSize: 12 }}>
                <strong>Limitations:</strong> {(job.config.limitations as string[]).join(" ")}
              </p>
            ) : null}
          </article>

          <div className="section-label">SOURCES</div>
          <article className="goal-card">
            {job.sources.length ? (
              <div className="job-sources">
                {job.sources.map((s) => (
                  <span key={s} className={`source-dot ${job.missing_sources.includes(s) ? "missing" : "ok"}`}>
                    {SOURCE_LABEL[s] ?? s} · {job.missing_sources.includes(s) ? "not connected" : "connected"}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">Uses derived signals (goals, findings, attention) rather than a connected source.</p>
            )}
            {job.missing_sources.length ? (
              <p className="muted" style={{ fontSize: 12 }}>
                Limited coverage: detectors that need {job.missing_sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")} are skipped. <Link href="/connections">Connect</Link> to widen it.
              </p>
            ) : null}
            {Array.isArray(job.config.would_need) && job.config.would_need.length ? (
              <p className="muted" style={{ fontSize: 12 }}>
                Would also benefit from: {(job.config.would_need as string[]).map((s) => SOURCE_LABEL[s] ?? s).join(", ")}.
              </p>
            ) : null}
            {lastRun?.coverage?.length ? (
              <p className="muted" style={{ fontSize: 12 }}>
                Last run coverage: {lastRun.coverage.map((c) => `${SOURCE_LABEL[c.source] ?? c.source} ${c.status}${c.freshness ? ` (${c.freshness})` : ""}`).join(" · ")}
              </p>
            ) : null}
          </article>

          <div className="section-label">SCHEDULE</div>
          <article className="goal-card">
            <p>{job.schedule_label}</p>
            <p className="muted" style={{ fontSize: 12 }}>
              Times are in {job.timezone ?? "your"} timezone. Event-driven jobs also run when their sources sync.
            </p>
          </article>

          <div className="section-label">NOTIFICATION POLICY</div>
          <article className="goal-card">
            <dl className="kv">
              <dt>Push from</dt>
              <dd>{policy.push ? `${policy.min_importance} and above` : "never (stored only)"}</dd>
              <dt>Briefing only</dt>
              <dd>{policy.briefing_only ? "yes — appears in the next brief" : "no"}</dd>
              <dt>Max per day</dt>
              <dd>{policy.max_per_day} new alerts; the rest become informational</dd>
              <dt>Minimum severity</dt>
              <dd>{job.minimum_severity}</dd>
            </dl>
          </article>
        </div>

        <div className="job-detail-col">
          <div className="section-label">RULES FOR THIS JOB</div>
          <article className="goal-card">
            {rules === null ? (
              <p className="muted">Loading…</p>
            ) : rules.length ? (
              rules.map((r) => (
                <div key={r.id} className="focus-row static">
                  <span className={`pill ${r.enabled ? "ok" : "neutral"}`}>{r.enabled ? "on" : "off"}</span>
                  <span className="focus-copy">
                    <strong>{r.name}</strong>
                    <small>{r.summary}</small>
                  </span>
                  <button className="button secondary" type="button" onClick={() => jeff.openModal(<RuleEditor rule={r} targetJob={job.slug} onSaved={reload} />)}>
                    Edit
                  </button>
                </div>
              ))
            ) : (
              <p className="muted">No job-scoped rules. Global rules from Memory & rules still apply.</p>
            )}
            <div>
              <button className="button secondary" type="button" onClick={() => jeff.openModal(<RuleEditor targetJob={job.slug} onSaved={reload} />)}>
                <Icon name="plus" /> Add rule for this job
              </button>
            </div>
          </article>

          <div className="section-label">LAST RUN</div>
          <article className="goal-card">
            {lastRun ? <RunSummary run={lastRun} /> : <p className="muted">Never run. Try Test first.</p>}
          </article>

          <div className="section-label">RUN HISTORY</div>
          <article className="goal-card">
            {runs.length ? (
              runs.slice(0, 10).map((r) => (
                <div key={r.id} className="focus-row static">
                  <span className={`pill ${RUN_TONE[r.status] ?? "neutral"}`}>{r.mode === "test" ? "TEST" : r.status}</span>
                  <span className="focus-copy">
                    <strong>
                      {fmtWhen(r.started_at)} · {r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
                    </strong>
                    <small>
                      {r.mode === "test" ? `${r.results?.length ?? 0} would-be findings` : `${r.stats.findings_created ?? 0} new · ${r.stats.findings_updated ?? 0} updated · ${r.stats.findings_resolved ?? 0} resolved · ${r.stats.alerts_created ?? 0} alerts`}
                      {r.error ? ` · ${r.error}` : ""}
                    </small>
                  </span>
                </div>
              ))
            ) : (
              <p className="muted">No runs yet.</p>
            )}
          </article>

          <div className="section-label">FINDINGS</div>
          <article className="goal-card">
            {findings === null ? (
              <p className="muted">Loading…</p>
            ) : findings.length ? (
              findings.slice(0, 20).map((f) => <FindingRow key={f.id} finding={f} job={job} onChanged={reload} />)
            ) : (
              <p className="muted">No findings from this job yet.</p>
            )}
          </article>

          <div className="section-label">SETTINGS</div>
          <article className="goal-card">
            <dl className="kv">
              <dt>Slug</dt>
              <dd>
                <code>{job.slug}</code>
              </dd>
              <dt>Managed by</dt>
              <dd>{job.system_managed ? "Jeff (system job — name, purpose and detectors refresh with updates; your schedule, policy and status are kept)" : `you (created by ${job.created_by})`}</dd>
              <dt>Created</dt>
              <dd>{fmtWhen(job.created_at)}</dd>
              {job.config.request ? (
                <>
                  <dt>Original request</dt>
                  <dd>“{String(job.config.request)}”</dd>
                </>
              ) : null}
            </dl>
          </article>
        </div>
      </div>
    </section>
  );
}

function RunSummary({ run }: { run: JobRunRow }) {
  const s = run.stats;
  return (
    <>
      <div className="mission-card-top">
        <span className="mission-code">{run.mode.toUpperCase()}</span>
        <span className={`pill ${RUN_TONE[run.status] ?? "neutral"}`}>{run.status}</span>
      </div>
      <dl className="kv">
        <dt>Started</dt>
        <dd>{fmtWhen(run.started_at)}</dd>
        <dt>Duration</dt>
        <dd>{run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : "—"}</dd>
        <dt>Records</dt>
        <dd>{s.records_considered ?? 0} considered · {s.candidates ?? 0} candidates · {s.rules_matched ?? 0} rule matches</dd>
        <dt>Findings</dt>
        <dd>
          {run.mode === "test" ? `${run.results?.length ?? 0} would-be (nothing created)` : `${s.findings_created ?? 0} new · ${s.findings_updated ?? 0} updated · ${s.findings_resolved ?? 0} resolved · ${s.duplicates_suppressed ?? 0} duplicates`}
        </dd>
        <dt>Alerts</dt>
        <dd>{run.mode === "test" ? "none (test)" : s.alerts_created ?? 0}</dd>
        {s.ai_calls ? (
          <>
            <dt>AI</dt>
            <dd>
              {s.ai_calls} call{s.ai_calls === 1 ? "" : "s"} · ${Number(s.cost_usd ?? 0).toFixed(3)}
            </dd>
          </>
        ) : null}
      </dl>
      {s.notes?.length ? (
        <ul className="muted" style={{ fontSize: 12, paddingLeft: 18 }}>
          {s.notes.slice(0, 6).map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      {run.error ? <div className="auth-error">{run.error}</div> : null}
    </>
  );
}

function FindingRow({ finding, job, onChanged }: { finding: JobFinding; job: JobItem; onChanged: () => Promise<void> }) {
  const jeff = useJeff();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(finding.status);

  async function feedback(verdict: "useful" | "already_knew" | "not_useful" | "dont_show" | "change_rule") {
    setBusy(true);
    try {
      const res = await api<{ rule?: { name: string }; suppressed?: number; proposed?: RuleProposal | null }>(`/api/findings/${finding.id}/feedback`, { method: "POST", body: JSON.stringify({ verdict }) });
      if (!res.ok) return jeff.toast(`Could not record feedback (${res.error ?? res.status}).`);
      void jeff.refreshBrain({ force: true });
      const d = res.data;
      if (verdict === "useful") {
        setStatus("accepted");
        jeff.toast("Marked useful.");
      } else if (verdict === "already_knew") {
        setStatus("acknowledged");
        jeff.toast(d?.proposed ? "Noted — you already knew. Want a rule so this job stops repeating it? Use Create rule." : "Noted — you already knew. It stays out of your attention.");
      } else if (verdict === "not_useful") {
        setStatus("dismissed");
        jeff.toast("Dismissed.");
      } else if (verdict === "dont_show") {
        setStatus(d?.rule ? "suppressed_by_rule" : "dismissed");
        jeff.toast(d?.rule ? `Rule added: “${d.rule.name}” · ${d.suppressed ?? 0} suppressed.` : "Dismissed. No safe narrow rule could be inferred.");
      } else if (verdict === "change_rule") {
        if (d?.proposed) return jeff.openModal(<RuleEditor proposed={d.proposed} targetJob={job.slug} onSaved={onChanged} />);
        return jeff.openModal(<RuleEditor targetJob={job.slug} onSaved={onChanged} />);
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  const done = ["dismissed", "suppressed_by_rule", "resolved"].includes(status);
  return (
    <div className="job-finding">
      <div className="mission-card-top">
        <span className="mission-code">{finding.category.replace(/_/g, " ").toUpperCase()}</span>
        <span style={{ display: "flex", gap: 6 }}>
          <span className={`pill ${SEVERITY_TONE[finding.severity] ?? "neutral"}`}>{finding.severity}</span>
          <span className="pill neutral">{status.replace(/_/g, " ")}</span>
        </span>
      </div>
      <strong>{finding.title}</strong>
      {finding.summary ? <p className="muted">{finding.summary}</p> : null}
      <p className="muted" style={{ fontSize: 11 }}>
        First seen {fmtWhen(finding.first_seen_at)} · last {fmtWhen(finding.last_seen_at)} · <Link href="/insights">open in Insights</Link>
      </p>
      {!done ? (
        <div className="connection-actions feedback-actions">
          {(
            [
              ["useful", "Useful"],
              ["already_knew", "Already knew this"],
              ["not_useful", "Not useful"],
              ["dont_show", "Don't show again"],
              ["change_rule", "Create rule"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="button secondary" type="button" disabled={busy} onClick={() => feedback(v)}>
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Edit                                                                */
/* ------------------------------------------------------------------ */

function EditJobModal({ job, onSaved }: { job: JobItem; onSaved: () => Promise<void> }) {
  const jeff = useJeff();
  const [name, setName] = useState(job.name);
  const [purpose, setPurpose] = useState(job.purpose);
  const [schedule, setSchedule] = useState(job.schedule_type);
  const [expr, setExpr] = useState(job.schedule_expression ?? "");
  const [scope, setScope] = useState(job.scope);
  const [minImportance, setMinImportance] = useState(job.notification_policy.min_importance);
  const [push, setPush] = useState(job.notification_policy.push);
  const [briefingOnly, setBriefingOnly] = useState(job.notification_policy.briefing_only);
  const [maxPerDay, setMaxPerDay] = useState(String(job.notification_policy.max_per_day));
  const [minSeverity, setMinSeverity] = useState(job.minimum_severity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        scope,
        schedule_type: schedule,
        schedule_expression: expr.trim() || null,
        minimum_severity: minSeverity,
        notification_policy: { min_importance: minImportance, push, briefing_only: briefingOnly, max_per_day: Number(maxPerDay) },
      };
      if (!job.system_managed) {
        body.name = name;
        body.purpose = purpose;
        body.description = purpose.slice(0, 600);
      }
      const res = await api<{ job: JobItem; issues?: { path: string; message: string }[] }>(`/api/jobs/${job.slug}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) return setError(res.data?.issues?.map((i) => `${i.path}: ${i.message}`).join("; ") ?? res.error ?? `HTTP ${res.status}`);
      await onSaved();
      jeff.closeModal();
      jeff.toast("Job updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ModalHeader title={`Edit ${job.ui_name}`} desc={job.system_managed ? "System job: schedule, scope and notification policy are yours; name and purpose update with Jeff." : "Tier-1 configuration. Changes take effect on the next run."} eyebrow="EDIT JOB" />
      <form className="modal-body form-grid" onSubmit={submit}>
        {error ? <div className="auth-error">{error}</div> : null}
        {!job.system_managed ? (
          <>
            <label className="field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={80} />
            </label>
            <label className="field">
              Purpose
              <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={2000} />
            </label>
          </>
        ) : null}
        <div className="form-grid-2">
          <label className="field">
            Scope
            <select value={scope} onChange={(e) => setScope(e.target.value as JobItem["scope"])}>
              <option value="business">Business</option>
              <option value="financial">Financial</option>
              <option value="personal">Personal</option>
              <option value="all">All</option>
            </select>
          </label>
          <label className="field">
            Schedule
            <select value={schedule} onChange={(e) => setSchedule(e.target.value as JobItem["schedule_type"])}>
              {["daily", "weekly", "monthly", "hourly", "event_driven", "continuous", "custom", "manual"].map((v) => (
                <option key={v} value={v}>
                  {v.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          When (owner timezone)
          <input value={expr} onChange={(e) => setExpr(e.target.value)} maxLength={60} placeholder={schedule === "weekly" ? "fri 07:05" : schedule === "monthly" ? "1 07:05" : "07:05"} />
          <small>weekly: “mon 07:05” · monthly: “1 07:05” · daily/event-driven: “07:05” · custom: cron</small>
        </label>
        <div className="form-grid-2">
          <label className="field">
            Notify from
            <select value={minImportance} onChange={(e) => setMinImportance(e.target.value as JobItem["notification_policy"]["min_importance"])}>
              <option value="informational">Informational</option>
              <option value="briefing">Briefing</option>
              <option value="important">Important</option>
              <option value="urgent">Urgent</option>
              <option value="actionable">Actionable</option>
            </select>
          </label>
          <label className="field">
            Max alerts per day
            <input type="number" min={0} max={50} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} />
          </label>
        </div>
        <label className="field">
          Minimum severity
          <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as JobItem["minimum_severity"])}>
            <option value="info">Info</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Allow push notifications
        </label>
        <label className="check-row">
          <input type="checkbox" checked={briefingOnly} onChange={(e) => setBriefingOnly(e.target.checked)} /> Briefing only (never interrupt; include in the next brief)
        </label>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="check" />} Save
          </button>
        </div>
      </form>
    </>
  );
}
