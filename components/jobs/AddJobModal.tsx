"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { ModalHeader } from "@/components/jeff/shared";
import { api, SOURCE_LABEL, type DetectorItem, type Interpretation, type JobItem, type TemplateItem } from "./types";

type Tab = "describe" | "templates" | "manual";

const SCHEDULES: [string, string][] = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["hourly", "Hourly"],
  ["event_driven", "When sources change"],
  ["continuous", "Continuous"],
  ["manual", "Manual only"],
];

/**
 * + Add Job. Three doors: describe it in plain language (Jeff proposes a
 * declarative definition and shows what it can and cannot cover), pick a
 * template, or configure it by hand. Jobs are configuration, never code.
 */
export function AddJobModal({ onCreated }: { onCreated: (job?: JobItem) => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("describe");
  return (
    <>
      <ModalHeader title="What should Jeff keep an eye on?" desc="Describe it the way you'd tell a new analyst. Jeff only uses sources you've connected and tells you what it would still need." eyebrow="ADD JOB" />
      <div className="modal-body">
        <div className="job-tabs" role="tablist">
          {(
            [
              ["describe", "Describe it"],
              ["templates", "Browse templates"],
              ["manual", "Configure manually"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`job-tab${tab === t ? " active" : ""}`} type="button" onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "describe" ? <DescribeTab onCreated={onCreated} /> : tab === "templates" ? <TemplatesTab onCreated={onCreated} /> : <ManualTab onCreated={onCreated} />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Describe                                                            */
/* ------------------------------------------------------------------ */

function DescribeTab({ onCreated }: { onCreated: (job?: JobItem) => Promise<void> }) {
  const jeff = useJeff();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Interpretation | null>(null);

  async function interpret(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ interpretation: Interpretation }>("/api/jobs/interpret", { method: "POST", body: JSON.stringify({ description: text }) });
      if (!res.ok || !res.data) return jeff.toast(`Could not interpret that (${res.error ?? res.status}).`);
      setProposal(res.data.interpretation);
    } finally {
      setBusy(false);
    }
  }

  async function create(draft: boolean) {
    setBusy(true);
    try {
      const res = await api<{ outcome: string; job: JobItem | null; reason?: string | null; notes?: string[] }>("/api/jobs", { method: "POST", body: JSON.stringify({ description: text, draft }) });
      if (!res.ok || !res.data) return jeff.toast(`Could not create the job (${res.error ?? res.status}).`);
      const d = res.data;
      if (d.outcome === "matches_system_job") {
        jeff.toast(`An existing job already covers this${d.job ? `: ${d.job.ui_name}` : ""}. Open it to run or resume.`);
      } else if (d.outcome === "needs_input") {
        jeff.toast(d.reason ?? "Jeff needs one more detail before creating this job.");
        return;
      } else if (d.outcome === "created_draft") {
        jeff.toast(`Created “${d.job?.name}” as a draft — review it before it runs.`);
      } else if (d.job) {
        jeff.toast(`Created “${d.job.name}” · ${d.job.schedule_label}.`);
      }
      await onCreated(d.job ?? undefined);
      jeff.closeModal();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={interpret}>
      <label className="field">
        Describe the job
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} required placeholder="Create a job that checks every Friday for clients we do way more work for than they pay us for." />
      </label>
      {proposal ? (
        <div className="job-proposal">
          <div className="mission-card-top">
            <span className="mission-code">{proposal.scope.toUpperCase()}</span>
            <span className={`pill ${proposal.safe ? "ok" : "amber"}`}>{proposal.safe ? "Safe to run" : "Needs review"}</span>
          </div>
          <h3>{proposal.name}</h3>
          <p className="muted">{proposal.purpose}</p>
          <dl className="kv">
            <dt>Schedule</dt>
            <dd>
              {proposal.schedule_type}
              {proposal.schedule_expression ? ` · ${proposal.schedule_expression}` : ""}
            </dd>
            <dt>Will use</dt>
            <dd>{proposal.sources.length ? proposal.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ") : "—"}</dd>
            <dt>Would need</dt>
            <dd>{proposal.would_need.length ? proposal.would_need.map((s) => SOURCE_LABEL[s] ?? s).join(", ") : "Nothing else"}</dd>
            <dt>Detectors</dt>
            <dd>{proposal.detectors.length ? proposal.detectors.join(", ") : "None available yet"}</dd>
            <dt>Notifies</dt>
            <dd>
              {proposal.notification_policy.min_importance}+ · {proposal.notification_policy.push ? "push on" : "no push"} · max {proposal.notification_policy.max_per_day}/day
            </dd>
          </dl>
          {proposal.limitations.length ? (
            <p className="muted" style={{ fontSize: 12 }}>
              <strong>Limitations:</strong> {proposal.limitations.join(" ")}
            </p>
          ) : null}
          {proposal.ambiguities.length ? (
            <div className="callout">
              <strong>Jeff would ask:</strong> {proposal.ambiguities.map((a) => a.question).join(" ")}
            </div>
          ) : null}
          {proposal.matches_system_job ? <div className="callout">This matches an existing system job ({proposal.matches_system_job}). Creating will point you there instead of duplicating it.</div> : null}
        </div>
      ) : (
        <div className="callout">Jeff proposes a definition first — sources, schedule, what it would still need — and creates nothing until you confirm.</div>
      )}
      <div className="modal-actions">
        {proposal ? (
          <>
            <button className="button secondary" type="button" disabled={busy} onClick={() => create(true)}>
              Create as draft
            </button>
            <button className="button primary" type="button" disabled={busy || !proposal.detectors.length} onClick={() => create(false)}>
              {busy ? <span className="spinner" /> : <Icon name="check" />}
              Create job
            </button>
          </>
        ) : (
          <button className="button primary" type="submit" disabled={busy || text.trim().length < 8}>
            {busy ? <span className="spinner" /> : <Icon name="sparkles" />}
            Propose
          </button>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

function TemplatesTab({ onCreated }: { onCreated: (job?: JobItem) => Promise<void> }) {
  const jeff = useJeff();
  const [templates, setTemplates] = useState<TemplateItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: TemplateItem[] }>("/api/jobs/templates").then((r) => setTemplates(r.data?.templates ?? []));
  }, []);

  async function use(t: TemplateItem) {
    if (t.system_slug) {
      jeff.closeModal();
      jeff.navigate(`/jobs/${t.system_slug}`);
      return;
    }
    if (!t.scaffold) return;
    setBusy(t.id);
    try {
      const slug = `${t.id}-${Math.random().toString(36).slice(2, 6)}`;
      const job = { slug, name: t.name, description: t.description, purpose: t.description, job_type: "user", status: t.missing_sources.length ? "draft" : "active", ...t.scaffold };
      const res = await api<{ job: JobItem }>("/api/jobs", { method: "POST", body: JSON.stringify({ job }) });
      if (!res.ok || !res.data?.job) return jeff.toast(`Could not create from template (${res.error ?? res.status}).`);
      jeff.toast(`Created “${t.name}”${t.missing_sources.length ? " as a draft — connect its sources to activate" : ""}.`);
      await onCreated(res.data.job);
      jeff.closeModal();
    } finally {
      setBusy(null);
    }
  }

  if (!templates) return <p className="muted">Loading templates…</p>;
  const cats = [...new Set(templates.map((t) => t.category))];
  return (
    <div className="template-list">
      {cats.map((c) => (
        <div key={c}>
          <div className="section-label">{c.toUpperCase()}</div>
          {templates
            .filter((t) => t.category === c)
            .map((t) => (
              <div key={t.id} className="focus-row static template-row">
                <span className="focus-copy">
                  <strong>{t.name}</strong>
                  <small>
                    {t.description}
                    {t.missing_sources.length ? ` · needs ${t.missing_sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")}` : ""}
                  </small>
                </span>
                <button className="button secondary" type="button" disabled={busy === t.id} onClick={() => use(t)}>
                  {t.system_slug ? "Open" : "Use"}
                </button>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Manual                                                              */
/* ------------------------------------------------------------------ */

function ManualTab({ onCreated }: { onCreated: (job?: JobItem) => Promise<void> }) {
  const jeff = useJeff();
  const [catalog, setCatalog] = useState<{ detectors: DetectorItem[]; connected: string[] } | null>(null);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState("business");
  const [schedule, setSchedule] = useState("daily");
  const [expr, setExpr] = useState("07:05");
  const [detectors, setDetectors] = useState<string[]>([]);
  const [minImportance, setMinImportance] = useState("important");
  const [maxPerDay, setMaxPerDay] = useState("5");
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ detectors: DetectorItem[]; connected: string[] }>("/api/jobs/templates").then((r) => setCatalog(r.data ? { detectors: r.data.detectors ?? [], connected: r.data.connected ?? [] } : { detectors: [], connected: [] }));
  }, []);

  const sources = [...new Set(detectors.flatMap((d) => catalog?.detectors.find((x) => x.id === d)?.sources ?? []))];
  const missing = sources.filter((s) => !catalog?.connected.includes(s));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
      const job = {
        slug: slug.length >= 3 ? slug : `job-${Date.now().toString(36)}`,
        name,
        purpose,
        description: purpose.slice(0, 600),
        scope,
        job_type: "user",
        status: detectors.length && !missing.length ? "active" : "draft",
        schedule_type: schedule,
        schedule_expression: ["daily", "weekly", "monthly", "custom", "event_driven"].includes(schedule) ? expr : null,
        sources,
        detectors,
        notification_policy: { min_importance: minImportance, push, briefing_only: false, max_per_day: Number(maxPerDay) },
      };
      const res = await api<{ job: JobItem; issues?: { path: string; message: string }[] }>("/api/jobs", { method: "POST", body: JSON.stringify({ job }) });
      if (!res.ok || !res.data?.job) return setError(res.data?.issues?.map((i) => `${i.path}: ${i.message}`).join("; ") ?? res.error ?? `HTTP ${res.status}`);
      jeff.toast(`Created “${name}”.`);
      await onCreated(res.data.job);
      jeff.closeModal();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      {error ? <div className="auth-error">{error}</div> : null}
      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={80} placeholder="Payments watch" />
      </label>
      <label className="field">
        Purpose
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={2000} placeholder="What this analyst is responsible for noticing." />
      </label>
      <div className="form-grid-2">
        <label className="field">
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="business">Business</option>
            <option value="financial">Financial</option>
            <option value="personal">Personal</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="field">
          Schedule
          <select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
            {SCHEDULES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {["daily", "weekly", "monthly", "event_driven", "custom"].includes(schedule) ? (
        <label className="field">
          When (owner timezone)
          <input value={expr} onChange={(e) => setExpr(e.target.value)} maxLength={60} placeholder={schedule === "weekly" ? "fri 07:05" : schedule === "monthly" ? "1 07:05" : "07:05"} />
          <small>{schedule === "weekly" ? "weekday + time, e.g. mon 07:05" : schedule === "monthly" ? "day of month + time, e.g. 1 07:05" : schedule === "custom" ? "cron: m h dom mon dow" : "time, e.g. 07:05"}</small>
        </label>
      ) : null}
      <div className="field">
        Detectors
        <div className="detector-picker">
          {(catalog?.detectors ?? []).map((d) => (
            <label key={d.id} className={`detector-option${detectors.includes(d.id) ? " on" : ""}`}>
              <input type="checkbox" checked={detectors.includes(d.id)} onChange={(e) => setDetectors((cur) => (e.target.checked ? [...cur, d.id] : cur.filter((x) => x !== d.id)))} />
              <span>
                <strong>{d.label}</strong>
                <small>{d.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ") || "derived"}</small>
              </span>
            </label>
          ))}
          {catalog && !catalog.detectors.length ? <p className="muted">No detectors available.</p> : null}
        </div>
        {missing.length ? <small className="muted">Needs {missing.map((s) => SOURCE_LABEL[s] ?? s).join(", ")} — will be created as a draft until connected.</small> : null}
      </div>
      <div className="form-grid-2">
        <label className="field">
          Notify from
          <select value={minImportance} onChange={(e) => setMinImportance(e.target.value)}>
            <option value="informational">Informational</option>
            <option value="briefing">Briefing</option>
            <option value="important">Important</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label className="field">
          Max alerts per day
          <input type="number" min={0} max={50} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} />
        </label>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Allow push notifications from this job
      </label>
      <div className="modal-actions">
        <button className="button primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? <span className="spinner" /> : <Icon name="check" />}
          Create job
        </button>
      </div>
    </form>
  );
}
