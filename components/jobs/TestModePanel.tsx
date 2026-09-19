"use client";

import { useState } from "react";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { ModalHeader } from "@/components/jeff/shared";
import { RuleEditor } from "@/components/memory/MemoryRulesView";
import { api, SOURCE_LABEL, type JobItem, type RunOutcome, type TestResult } from "./types";

const SEVERITY_TONE: Record<string, string> = { high: "danger", medium: "amber", low: "neutral", info: "info" };

/**
 * TEST MODE panel. Shows what a job WOULD find right now. Nothing here is a
 * finding: no alerts, pushes, missions or state changes happened. Feedback on
 * a would-be result is recorded against the test run (not a finding) and can
 * seed a job-scoped rule so the next real run already respects it.
 */
export function TestModePanel({ job, outcome, onRuleSaved }: { job: JobItem; outcome: RunOutcome; onRuleSaved?: () => Promise<void> }) {
  const jeff = useJeff();
  const [verdicts, setVerdicts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const missing = outcome.coverage.filter((c) => c.status !== "ok");

  async function feedback(index: number, verdict: "useful" | "wrong" | "too_noisy") {
    setBusy(index);
    try {
      const res = await api<{ ok: boolean }>(`/api/jobs/runs/${outcome.runId}`, { method: "PATCH", body: JSON.stringify({ index, verdict }) });
      if (!res.ok) return jeff.toast(`Could not record feedback (${res.error ?? res.status}).`);
      setVerdicts((v) => ({ ...v, [index]: verdict }));
      jeff.toast(verdict === "useful" ? "Noted — Jeff will keep surfacing results like this." : "Noted. Consider 'Ignore pattern' to make it a rule.");
    } finally {
      setBusy(null);
    }
  }

  function ignorePattern(r: TestResult) {
    jeff.openModal(
      <RuleEditor
        targetJob={job.slug}
        proposed={{
          name: `${job.ui_name}: ignore ${r.category.replace(/_/g, " ")} like "${r.title.slice(0, 40)}"`,
          target_monitor: r.category,
          conditions: { category: r.category },
          action: { type: "exclude" },
          description: `Proposed from TEST MODE of ${job.ui_name}. Narrow it further (sender, subject, amount) before saving.`,
        }}
        onSaved={onRuleSaved ?? (async () => {})}
      />,
    );
  }

  return (
    <>
      <ModalHeader title={`${job.ui_name} — TEST MODE`} desc="What this job would have found right now. Nothing was created, sent or changed. The only record is the test run itself." eyebrow="🧪 TEST MODE — NOT REAL" />
      <div className="modal-body">
        <div className="callout test-callout">
          <strong>Sandbox.</strong> {outcome.stats.records_considered ?? 0} records considered · {outcome.stats.candidates ?? outcome.results.length} would-be findings · {outcome.stats.rules_matched ?? 0} rule matches · {outcome.stats.duplicates_suppressed ?? 0} duplicates. Status: {outcome.status}.
        </div>
        {missing.length ? (
          <p className="muted" style={{ fontSize: 12 }}>
            Coverage: {missing.map((c) => `${SOURCE_LABEL[c.source] ?? c.source} ${c.status}`).join(", ")}. Detectors that need those sources were skipped, not run on partial data.
          </p>
        ) : null}
        {outcome.notes.length ? (
          <ul className="muted" style={{ fontSize: 12, paddingLeft: 18 }}>
            {outcome.notes.slice(0, 8).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
        <div className="section-label">WOULD-BE FINDINGS</div>
        {outcome.results.length ? (
          <div className="test-results">
            {outcome.results.map((r, i) => (
              <article key={r.fingerprint + i} className="test-result">
                <div className="mission-card-top">
                  <span className="mission-code">{r.category.replace(/_/g, " ").toUpperCase()}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <span className={`pill ${SEVERITY_TONE[r.severity] ?? "neutral"}`}>{r.severity}</span>
                    {r.existing ? <span className="pill neutral">already open</span> : <span className="pill info">would be new</span>}
                  </span>
                </div>
                <h3>{r.title}</h3>
                {r.observed_facts.length ? (
                  <ul className="test-facts">
                    {r.observed_facts.slice(0, 4).map((f, j) => (
                      <li key={j}>{f}</li>
                    ))}
                  </ul>
                ) : null}
                {r.interpretation ? <p className="muted">{r.interpretation}</p> : null}
                <p className="muted" style={{ fontSize: 11 }}>
                  {r.evidence_count} evidence item{r.evidence_count === 1 ? "" : "s"} · confidence {Math.round(r.confidence * 100)}%{r.limitations ? ` · ${r.limitations}` : ""}
                </p>
                <div className="connection-actions feedback-actions">
                  {verdicts[i] ? (
                    <span className="pill ok">
                      <Icon name="check" /> {verdicts[i]!.replace(/_/g, " ")}
                    </span>
                  ) : (
                    (
                      [
                        ["useful", "Useful"],
                        ["wrong", "Wrong"],
                        ["too_noisy", "Too noisy"],
                      ] as const
                    ).map(([v, label]) => (
                      <button key={v} className="button secondary" type="button" disabled={busy === i} onClick={() => feedback(i, v)}>
                        {label}
                      </button>
                    ))
                  )}
                  <button className="button secondary" type="button" onClick={() => ignorePattern(r)}>
                    Ignore pattern
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted focus-empty">Nothing would be surfaced right now{outcome.status === "partial" ? " (with partial coverage)" : ""}. That is a valid result — Jeff does not invent findings.</p>
        )}
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={() => jeff.openModal(<RuleEditor targetJob={job.slug} onSaved={onRuleSaved ?? (async () => {})} />)}>
            <Icon name="plus" /> Create rule for this job
          </button>
          <button className="button primary" type="button" onClick={jeff.closeModal}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
