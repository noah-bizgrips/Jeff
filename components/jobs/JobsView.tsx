"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState } from "@/components/jeff/shared";
import { AddJobModal } from "./AddJobModal";
import { TestModePanel } from "./TestModePanel";
import { JobsHealth } from "./JobsHealth";
import { api, fmtWhen, SOURCE_LABEL, STATUS_TONE, type JobItem, type RunOutcome } from "./types";

/** Jeff's Jobs roster (spec §6): one row per analyst with coverage, schedule, last run, findings and Test · Run now · Open. */
export function JobsView({ initial }: { initial: JobItem[] }) {
  const jeff = useJeff();
  const [jobs, setJobs] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await api<{ jobs: JobItem[] }>("/api/jobs");
    if (res.ok && res.data) setJobs(res.data.jobs);
  }, []);

  async function test(job: JobItem) {
    setBusy(`${job.slug}:test`);
    try {
      const res = await api<RunOutcome>(`/api/jobs/${job.slug}/test`, { method: "POST" });
      if (!res.ok || !res.data) return jeff.toast(`Test failed (${res.error ?? res.status}).`);
      jeff.openModal(<TestModePanel job={job} outcome={res.data} onRuleSaved={reload} />);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function run(job: JobItem) {
    setBusy(`${job.slug}:run`);
    try {
      const res = await api<RunOutcome>(`/api/jobs/${job.slug}/run`, { method: "POST" });
      if (!res.ok || !res.data) return jeff.toast(`Run failed (${res.error ?? res.status}).`);
      const s = res.data.stats;
      jeff.toast(`${job.ui_name}: ${s.findings_created ?? 0} new · ${s.findings_updated ?? 0} updated · ${s.findings_resolved ?? 0} resolved · ${s.alerts_created ?? 0} alert${s.alerts_created === 1 ? "" : "s"}${res.data.status === "partial" ? " (partial coverage)" : ""}.`);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  const active = jobs.filter((j) => ["active", "error"].includes(j.status));
  const rest = jobs.filter((j) => !["active", "error"].includes(j.status));
  const running = active.length;
  const limited = jobs.filter((j) => j.status_label === "LIMITED COVERAGE").length;

  return (
    <section className="page-view" id="jobsView">
      <div className="preview-banner">
        <Icon name="briefcase" />
        <span>
          <strong>Jobs are analysts, not automations.</strong> Each one watches specific sources on a schedule, produces findings with evidence, and never acts on its own. Test before you trust; scope rules to a job instead of muting a monitor.
        </span>
      </div>
      <div className="view-toolbar">
        <p>
          {running} active · {rest.length} paused or draft{limited ? ` · ${limited} with limited coverage` : ""}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="button secondary" type="button" onClick={reload}>
            <Icon name="refresh" /> Refresh
          </button>
          <button className="button primary" type="button" onClick={() => jeff.openModal(<AddJobModal onCreated={reload} />)}>
            <Icon name="plus" /> Add Job
          </button>
        </div>
      </div>

      <JobsHealth />

      {!jobs.length ? (
        <EmptyState icon="briefcase" title="No jobs yet.">
          The system roster seeds itself on first load. Add your own with a sentence — “every Friday, find clients we do more work for than they pay us for”.
        </EmptyState>
      ) : null}

      {active.length ? (
        <>
          <div className="section-label">RUNNING</div>
          <div className="job-list">
            {active.map((j) => (
              <JobRowView key={j.id} job={j} busy={busy} onTest={() => test(j)} onRun={() => run(j)} />
            ))}
          </div>
        </>
      ) : null}
      {rest.length ? (
        <>
          <div className="section-label">PAUSED · DRAFT · DISABLED</div>
          <div className="job-list">
            {rest.map((j) => (
              <JobRowView key={j.id} job={j} busy={busy} onTest={() => test(j)} onRun={() => run(j)} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function JobRowView({ job, busy, onTest, onRun }: { job: JobItem; busy: string | null; onTest: () => void; onRun: () => void }) {
  const canRun = job.detectors.length > 0 && job.status !== "disabled";
  return (
    <article className="job-row">
      <div className="job-row-main">
        <span className="job-icon" aria-hidden="true">
          {job.icon.length <= 3 ? job.icon : <Icon name="briefcase" />}
        </span>
        <div className="job-row-copy">
          <div className="job-row-title">
            <Link href={`/jobs/${job.slug}`}>
              <strong>{job.ui_name}</strong>
            </Link>
            <span className={`pill ${STATUS_TONE[job.status_label]}`}>{job.status_label}</span>
            {job.job_type !== "system" ? <span className="pill neutral">{job.job_type === "custom" ? "custom" : "yours"}</span> : null}
          </div>
          <p className="muted">{job.description}</p>
          <div className="job-meta">
            <span className="job-sources" title={job.sources.map((s) => `${SOURCE_LABEL[s] ?? s}: ${job.missing_sources.includes(s) ? "missing" : "connected"}`).join("\n")}>
              {job.sources.length ? (
                job.sources.map((s) => (
                  <span key={s} className={`source-dot ${job.missing_sources.includes(s) ? "missing" : "ok"}`}>
                    {SOURCE_LABEL[s] ?? s}
                  </span>
                ))
              ) : (
                <span className="muted">derived signals</span>
              )}
            </span>
            <span className="muted">{job.schedule_label}</span>
            <span className="muted">Last run {fmtWhen(job.last_run_at)}</span>
            <span className="muted">{job.findings_30d} finding{job.findings_30d === 1 ? "" : "s"} this month</span>
            {job.pending ? <span className="muted">· {job.pending}</span> : null}
          </div>
        </div>
      </div>
      <div className="job-actions">
        <button className="button secondary" type="button" disabled={busy === `${job.slug}:test` || !job.detectors.length} onClick={onTest} title="Analyse now without creating findings or alerts">
          {busy === `${job.slug}:test` ? <span className="spinner" /> : null} Test
        </button>
        <button className="button secondary" type="button" disabled={busy === `${job.slug}:run` || !canRun} onClick={onRun}>
          {busy === `${job.slug}:run` ? <span className="spinner" /> : <Icon name="play" />} Run now
        </button>
        <Link className="button secondary" href={`/jobs/${job.slug}`}>
          Open <Icon name="arrowUpRight" />
        </Link>
      </div>
    </article>
  );
}
