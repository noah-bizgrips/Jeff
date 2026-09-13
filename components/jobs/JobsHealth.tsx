"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { api, fmtWhen } from "./types";

/** Shape of GET /api/jobs/metrics (kept local so the component has no server imports). */
export interface JobsMetricsData {
  window_days: number;
  generated_at: string;
  totals: { runs: number; runs_per_day: number; succeeded: number; partial: number; failed: number; ai_calls: number; ai_cost_usd: number; findings_created: number; findings_suppressed: number; feedback: number; false_positive_rate: number | null; pending_proposals: number };
  jobs: { slug: string; name: string; status: string; runs: number; runs_per_day: number; succeeded: number; partial: number; failed: number; avg_duration_ms: number | null; last_run_at: string | null; last_status: string | null; ai_calls: number; ai_cost_usd: number; findings_created: number; findings_suppressed: number; feedback: Record<string, number>; false_positive_rate: number | null }[];
  follow_through: { open: number; overdue: number; waiting_on_other: number; snoozed: number; possibly_complete: number; completed_30d: number; auto_completed_30d: number; dismissed_30d: number; reminders_30d: number; reminders_per_day: number };
}

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function usd(v: number): string {
  return v ? `$${v.toFixed(v < 1 ? 3 : 2)}` : "$0";
}

/** "Jobs health" block (spec §55): runs, outcomes, AI cost by job, findings, feedback and Follow-Through, over the last 30 days. */
export function JobsHealth() {
  const [data, setData] = useState<JobsMetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ metrics: JobsMetricsData }>("/api/jobs/metrics");
    if (res.ok && res.data) {
      setData(res.data.metrics);
      setError(null);
    } else setError(res.error ?? `HTTP ${res.status}`);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <article className="goal-card" id="jobsHealth">
        <p className="muted">Jobs health is unavailable right now ({error}).</p>
      </article>
    );
  }
  if (!data) {
    return (
      <article className="goal-card" id="jobsHealth">
        <p className="muted">Loading jobs health…</p>
      </article>
    );
  }
  const t = data.totals;
  const ft = data.follow_through;
  const boxes: [string, string | number, string?][] = [
    ["Runs / day", t.runs_per_day, `${t.runs} in ${data.window_days} days`],
    ["Succeeded · partial · failed", `${t.succeeded} · ${t.partial} · ${t.failed}`],
    ["AI calls · cost", `${t.ai_calls} · ${usd(t.ai_cost_usd)}`],
    ["Findings created", t.findings_created, `${t.findings_suppressed} suppressed as duplicates or already known`],
    ["Feedback", t.feedback, `false-positive rate ${pct(t.false_positive_rate)}`],
    ["Follow-Through", `${ft.open} open · ${ft.overdue} overdue`, `${ft.reminders_per_day}/day reminders · ${ft.completed_30d} done · ${ft.auto_completed_30d} auto`],
  ];
  return (
    <article className="goal-card" id="jobsHealth">
      <div className="view-toolbar" style={{ marginBottom: 8 }}>
        <p>
          <strong>Jobs health</strong> <span className="muted">· last {data.window_days} days · updated {fmtWhen(data.generated_at)}</span>
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {t.pending_proposals ? (
            <Link className="button secondary" href="/memory">
              {t.pending_proposals} learned suggestion{t.pending_proposals === 1 ? "" : "s"} to review <Icon name="arrowUpRight" />
            </Link>
          ) : null}
          <button className="button secondary" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide per-job" : "Per-job detail"}
          </button>
          <button className="button secondary" type="button" onClick={load} aria-label="Refresh jobs health">
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="metric-grid">
        {boxes.map(([label, value, note]) => (
          <div className="metric-box" key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
            {note ? <span className="muted" style={{ fontSize: 10 }}>{note}</span> : null}
          </div>
        ))}
      </div>
      {open ? (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Runs</th>
                <th>OK · partial · failed</th>
                <th>Last run</th>
                <th>AI calls · cost</th>
                <th>Findings</th>
                <th>Suppressed</th>
                <th>Feedback</th>
                <th>False-positive</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.slug}>
                  <td>
                    <Link href={`/jobs/${j.slug}`}>{j.name}</Link>
                  </td>
                  <td>{j.runs}</td>
                  <td>
                    {j.succeeded} · {j.partial} · {j.failed}
                  </td>
                  <td>
                    {fmtWhen(j.last_run_at)}
                    {j.last_status ? ` (${j.last_status})` : ""}
                  </td>
                  <td>
                    {j.ai_calls} · {usd(j.ai_cost_usd)}
                  </td>
                  <td>{j.findings_created}</td>
                  <td>{j.findings_suppressed}</td>
                  <td>{Object.values(j.feedback).reduce((a, b) => a + b, 0)}</td>
                  <td>{pct(j.false_positive_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </article>
  );
}
