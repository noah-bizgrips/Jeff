import { evidenceOf, type CandidateFinding, type Monitor, type SourceRow } from "./types";

/** Reports failed n8n executions once n8n sync exists. Skips cleanly when there is no data. */
export const automationFailure: Monitor = {
  id: "automation_failure",
  run(rows, ctx) {
    const failed = rows.filter((r) => r.provider === "n8n" && r.resource_type === "execution" && String(r.metadata.status ?? "").toLowerCase() === "error");
    if (!failed.length) return [];
    const byWorkflow = new Map<string, SourceRow[]>();
    for (const f of failed) {
      const wf = String(f.metadata.workflowId ?? f.title ?? "unknown");
      byWorkflow.set(wf, [...(byWorkflow.get(wf) ?? []), f]);
    }
    const out: CandidateFinding[] = [];
    for (const [wf, list] of byWorkflow) {
      const name = list[0]!.title ?? wf;
      out.push({
        fingerprint: `automation_failure:${wf}`,
        category: "automation_failure",
        title: `${list.length} failed execution${list.length === 1 ? "" : "s"} in workflow ${name}`,
        observed_facts: list.slice(0, 5).map((f) => `Execution ${f.external_id} failed at ${f.source_timestamp ?? "unknown time"}.`),
        metrics: { failures: list.length, formula: "count(status = error)" },
        interpretation: "Interpretation: repeated failures usually indicate a credential, schema, or upstream change. Investigate before relying on downstream data.",
        evidence: list.slice(0, 5).map(evidenceOf),
        range_start: list.map((f) => f.source_timestamp).filter((x): x is string => !!x).sort()[0] ?? null,
        range_end: ctx.now.toISOString(),
        confidence: 0.9,
        limitations: "Only executions synced from n8n are considered.",
        severity: list.length > 3 ? "high" : "medium",
        proposed_mission: {
          title: `Investigate failures in ${name}`,
          goal: `Investigate the failing n8n workflow ${wf} using execution logs and prepare a fix in a gomez-test copy. Do not modify production workflows.`,
        },
      });
    }
    return out;
  },
};
