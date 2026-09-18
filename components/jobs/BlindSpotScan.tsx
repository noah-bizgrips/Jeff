"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/gomez/icons";
import { useGomez } from "@/components/gomez/store";
import { sourcesForScanStage } from "@/lib/gomez/brain/sources";
import { RuleEditor } from "@/components/memory/MemoryRulesView";
import type { RuleAction, RuleCondition } from "@/lib/gomez/rules/schema";
import { api, fmtWhen, type JobFinding, type JobRunRow } from "./types";

export interface JobsSummary {
  active: number;
  total: number;
  limited: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  scannerStatus: string | null;
}

interface Poll {
  run: JobRunRow;
  progress: string;
  progress_label: string;
  findings: JobFinding[];
}

type ScanState = { phase: "idle" } | { phase: "running"; scanId: string; label: string } | { phase: "done"; run: JobRunRow; findings: JobFinding[]; dismissed: string[] } | { phase: "error"; message: string };

/**
 * Mission Control: the Jobs status line and the "✦ Find what I'm missing"
 * button. The button runs the Blind Spot Scanner job for real (findings,
 * novelty, daily cap) and polls its run for progress until it completes.
 */
export function JobsStatusLine({ summary }: { summary: JobsSummary | null }) {
  if (!summary) return null;
  return (
    <p className="jobs-status-line">
      <Icon name="briefcase" /> <strong>Jobs</strong> · {summary.active} of {summary.total} running{summary.limited ? ` · ${summary.limited} limited coverage` : ""} · last run {fmtWhen(summary.lastRunAt)}
      {summary.nextRunAt ? ` · next ${fmtWhen(summary.nextRunAt)}` : ""} · <Link href="/jobs">Manage</Link>
    </p>
  );
}

export function BlindSpotScanButton({ disabled }: { disabled?: boolean }) {
  const gomez = useGomez();
  const [state, setState] = useState<ScanState>({ phase: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // The brain shows the scan examining sources by stage ("scanning", not retrieval) and refreshes when it finishes.
  const goalSources = gomez.brain.reasons.attention.filter((r) => r.kind === "goal").flatMap((r) => r.sources);
  function scanning(stage: string) {
    gomez.setBrainActivity({ kind: "scan", sources: sourcesForScanStage(stage, gomez.connectedSources(), goalSources) });
  }
  function scanFinished() {
    gomez.setBrainActivity({ kind: null, sources: [] });
    void gomez.refreshBrain({ force: true });
  }

  async function poll(scanId: string, attempt = 0) {
    const res = await api<Poll>(`/api/jobs/runs/${scanId}`);
    if (!res.ok || !res.data) {
      if (attempt < 3) {
        timer.current = setTimeout(() => poll(scanId, attempt + 1), 2000);
        return;
      }
      setState({ phase: "error", message: res.error ?? `HTTP ${res.status}` });
      scanFinished();
      return;
    }
    const d = res.data;
    if (d.run.status === "running" || d.run.status === "queued") {
      setState({ phase: "running", scanId, label: d.progress_label });
      scanning(d.progress);
      timer.current = setTimeout(() => poll(scanId, 0), 1500);
      return;
    }
    scanFinished();
    if (d.run.status === "failed") return setState({ phase: "error", message: d.run.error ?? "The scan failed." });
    setState({ phase: "done", run: d.run, findings: d.findings, dismissed: [] });
  }

  async function start() {
    setState({ phase: "running", scanId: "", label: "Preparing scan" });
    scanning("preparing");
    const res = await api<{ scanId: string }>("/api/jobs/blind-spot-scan", { method: "POST" });
    if (!res.ok || !res.data?.scanId) {
      scanFinished();
      return setState({ phase: "error", message: res.error ?? `HTTP ${res.status}` });
    }
    void poll(res.data.scanId);
  }

  async function dismiss(f: JobFinding) {
    const res = await api<{ ok: boolean }>(`/api/findings/${f.id}/feedback`, { method: "POST", body: JSON.stringify({ verdict: "not_useful" }) });
    if (!res.ok) return gomez.toast(`Could not dismiss (${res.error ?? res.status}).`);
    setState((s) => (s.phase === "done" ? { ...s, dismissed: [...s.dismissed, f.id] } : s));
    void gomez.refreshBrain({ force: true });
  }

  async function createRule(f: JobFinding) {
    const res = await api<{ proposed?: { name: string; description?: string; target_monitor: string | null; conditions: RuleCondition; action: RuleAction } | null }>(`/api/findings/${f.id}/feedback`, { method: "POST", body: JSON.stringify({ verdict: "change_rule" }) });
    const proposed = res.data?.proposed ?? undefined;
    gomez.openModal(<RuleEditor proposed={proposed ?? undefined} targetJob="blind-spot-scanner" onSaved={async () => {}} />);
  }

  return (
    <div className="scan-panel">
      <div className="scan-head">
        <button className="button primary" id="blindSpotScanButton" type="button" disabled={disabled || state.phase === "running"} onClick={start}>
          {state.phase === "running" ? <span className="spinner" /> : <span aria-hidden="true">✦</span>} Find what I&apos;m missing
        </button>
        {state.phase === "running" ? (
          <span className="scan-progress" aria-live="polite">
            {state.label}…
          </span>
        ) : state.phase === "done" ? (
          <span className="muted">
            Scan {state.run.status}{state.run.duration_ms != null ? ` in ${(state.run.duration_ms / 1000).toFixed(1)}s` : ""} · <Link href="/jobs/blind-spot-scanner">details</Link>
          </span>
        ) : state.phase === "error" ? (
          <span className="auth-error" style={{ padding: "4px 8px" }}>
            {state.message}
          </span>
        ) : (
          <span className="muted">Runs the Blind Spot Scanner now — goals, commitments, obligations, financial changes, patterns.</span>
        )}
      </div>
      {state.phase === "done" ? (
        state.findings.filter((f) => !state.dismissed.includes(f.id)).length ? (
          <div className="scan-results">
            {state.findings
              .filter((f) => !state.dismissed.includes(f.id))
              .slice(0, 5)
              .map((f) => (
                <article key={f.id} className="job-finding">
                  <div className="mission-card-top">
                    <span className="mission-code">👁️ {(f.metrics?.theme ?? f.category).replace(/_/g, " ").toUpperCase()}</span>
                    <span className={`pill ${f.severity === "high" ? "danger" : f.severity === "medium" ? "amber" : "neutral"}`}>{f.severity}</span>
                  </div>
                  <strong>{f.title}</strong>
                  {f.summary ? <p className="muted">{f.summary}</p> : null}
                  {f.metrics?.novelty?.reason ? (
                    <p className="muted" style={{ fontSize: 11 }}>
                      {f.metrics.novelty.exception ? `Shown again: ${f.metrics.novelty.reason}` : f.metrics.novelty.reason}
                    </p>
                  ) : null}
                  <div className="connection-actions feedback-actions">
                    <button className="button secondary" type="button" onClick={() => gomez.ask(`Tell me more about this blind spot and what to check: "${f.title}"`)}>
                      Ask Gomez about this
                    </button>
                    <button className="button secondary" type="button" onClick={() => gomez.ask(`Prepare an action for: "${f.title}". Draft a mission with the evidence; I will approve before anything runs.`)}>
                      Prepare action
                    </button>
                    <button className="button secondary" type="button" onClick={() => dismiss(f)}>
                      Dismiss
                    </button>
                    <button className="button secondary" type="button" onClick={() => createRule(f)}>
                      Create rule
                    </button>
                  </div>
                </article>
              ))}
          </div>
        ) : (
          <p className="muted scan-empty">I didn&apos;t find anything important enough to surface.</p>
        )
      ) : null}
    </div>
  );
}
