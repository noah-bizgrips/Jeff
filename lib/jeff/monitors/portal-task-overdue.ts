import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { DAY, clientIndex, clientLabel, groupBy, isActiveClient, str } from "./portal-shared";

/**
 * Portal tasks past their due date and not complete, one finding per client.
 * Severity: BizGrips-owned overdue → high (we owe the client); client-owned
 * overdue > CLIENT_GRACE_DAYS → medium (the client is blocking their own
 * launch); a blocking task escalates one level.
 */
export const CLIENT_GRACE_DAYS = 7;

const ESCALATE: Record<CandidateFinding["severity"], CandidateFinding["severity"]> = { info: "low", low: "medium", medium: "high", high: "high" };

export const portalTaskOverdue: Monitor = {
  id: "portal_task_overdue",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const idx = clientIndex(rows);
    const overdue = rows.filter((r) => {
      if (r.provider !== "portal" || r.resource_type !== "task") return false;
      if (str(r.metadata.status) === "complete") return false;
      const due = str(r.metadata.due_at);
      return !!due && Date.parse(due) < now && isActiveClient(idx, str(r.metadata.client_id));
    });
    const out: CandidateFinding[] = [];
    for (const [clientId, tasks] of groupBy(overdue, (r) => str(r.metadata.client_id))) {
      const name = clientLabel(idx, clientId);
      const ours = tasks.filter((t) => str(t.metadata.owner) !== "Client");
      const theirs = tasks.filter((t) => str(t.metadata.owner) === "Client");
      const theirsLate = theirs.filter((t) => (now - Date.parse(str(t.metadata.due_at)!)) / DAY > CLIENT_GRACE_DAYS);
      if (!ours.length && !theirsLate.length) continue;
      let severity: CandidateFinding["severity"] = ours.length ? "high" : "medium";
      if (tasks.some((t) => t.metadata.blocking === true)) severity = ESCALATE[severity];
      const oldest = Math.max(...tasks.map((t) => (now - Date.parse(str(t.metadata.due_at)!)) / DAY));
      const facts = tasks.slice(0, 10).map((t) => {
        const days = Math.round((now - Date.parse(str(t.metadata.due_at)!)) / DAY);
        return `"${t.title}" (${str(t.metadata.owner) ?? "BizGrips"}${t.metadata.blocking === true ? ", blocking" : ""}) was due ${str(t.metadata.due_at)!.slice(0, 10)} — ${days} day${days === 1 ? "" : "s"} overdue${str(t.metadata.stage_title) ? `, stage "${str(t.metadata.stage_title)}"` : ""}.`;
      });
      out.push({
        fingerprint: `portal_task_overdue:${clientId}`,
        category: "portal_task_overdue",
        title: `${name}: ${tasks.length} overdue task${tasks.length === 1 ? "" : "s"}${ours.length ? ` (${ours.length} owed by BizGrips)` : ""}`,
        observed_facts: facts,
        metrics: {
          overdue_total: tasks.length,
          owed_by_bizgrips: ours.length,
          owed_by_client: theirs.length,
          owed_by_client_past_grace: theirsLate.length,
          blocking: tasks.filter((t) => t.metadata.blocking === true).length,
          oldest_overdue_days: Math.round(oldest * 10) / 10,
          client_grace_days: CLIENT_GRACE_DAYS,
          formula: "overdue = status != complete AND due_at < now; owed_by_bizgrips = owner in (BizGrips, Both)",
        },
        interpretation: ours.length
          ? `Interpretation: BizGrips is behind on ${ours.length} deliverable${ours.length === 1 ? "" : "s"} for ${name}; that is the kind of slip clients notice first. Client-owned items are listed for context.`
          : `Interpretation: ${name} has been sitting on ${theirsLate.length} of their own task${theirsLate.length === 1 ? "" : "s"} for more than ${CLIENT_GRACE_DAYS} days; the launch is blocked on them, and a nudge with the exact items usually unblocks it.`,
        evidence: tasks.slice(0, 15).map(evidenceOf),
        range_start: null,
        range_end: ctx.now.toISOString(),
        confidence: 0.9,
        limitations: "Due dates derive from the client's day zero; a corrected timeline shifts them. Tasks marked complete in the portal after the last sync clear on the next run.",
        severity,
        proposed_mission: {
          title: `Clear overdue portal tasks for ${name}`,
          goal: `Review the ${tasks.length} overdue task(s) for ${name} in the portal, complete or reschedule the BizGrips-owned ones, and draft a short nudge listing the client-owned items. Do not send anything.`,
        },
      });
    }
    return out;
  },
};
