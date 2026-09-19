import { evidenceOf, type CandidateFinding, type ExtendedContext, type SourceRow } from "./types";
import { DAY, money, num, tsOf } from "./finance-shared";
import { str } from "./portal-shared";

/**
 * Personal Project Tracker — stalled personal goals/projects and upcoming
 * personal renewals. Only personal-scope goals/obligations and rows that are
 * explicitly personal (scope tag or personal keywords). Concrete due items are
 * handed to Follow-Through via the obligation source adapter, not duplicated.
 */

export const STALLED_DAYS = 21;
export const RENEWAL_LOOKAHEAD_DAYS = 14;

export const PERSONAL_WORDS = /\b(home|house|gym|workout|fitness|trip|travel|vacation|flight|hotel|renew(al)?|dmv|license|passport|insurance|filter|maintenance|oil change|dentist|doctor|vet|birthday|anniversary|kids?|school|garden|garage|roof|hvac|furnace|mortgage|rent|utilities|netflix|spotify|apple|peloton|amazon prime)\b/i;

function isPersonalRow(r: SourceRow, ctx: ExtendedContext): boolean {
  if (r.tags.includes("personal")) return true;
  const scoped = (ctx.memories ?? []).filter((m) => m.scope === "personal").map((m) => m.content.toLowerCase());
  const text = `${r.title ?? ""} ${r.summary ?? ""}`.toLowerCase();
  if (scoped.some((m) => m.length > 6 && text.includes(m.slice(0, 40)))) return true;
  return PERSONAL_WORDS.test(text);
}

/** Active personal goals (and personal obligations) with no activity for STALLED_DAYS. */
export function personalProjectStalled(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const cutoff = now - STALLED_DAYS * DAY;
  const out: CandidateFinding[] = [];
  const personalRows = rows.filter((r) => isPersonalRow(r, ctx));
  for (const g of (ctx.goals ?? []).filter((g) => g.status === "active" && g.scope === "personal")) {
    const related = personalRows.filter((r) => g.keywords.some((k) => k.length > 3 && `${r.title ?? ""} ${r.summary ?? ""}`.toLowerCase().includes(k)));
    const lastActivity = Math.max(...related.map((r) => tsOf(r) ?? 0), g.updated_at ? Date.parse(g.updated_at) : 0);
    if (!lastActivity || lastActivity >= cutoff) continue;
    const days = Math.floor((now - lastActivity) / DAY);
    out.push({
      fingerprint: `personal_project_stalled:${g.id}`,
      category: "personal_project_stalled",
      title: `"${g.name}" has had no activity for ${days} days`,
      observed_facts: [`Last related activity ${new Date(lastActivity).toISOString().slice(0, 10)} (${related.length} related calendar/email/note items found).`, g.trajectory ? `Trajectory: ${g.trajectory.replace(/_/g, " ")}.` : "No trajectory yet."],
      metrics: { stalled_days: days, related_items: related.length, threshold_days: STALLED_DAYS, formula: `max(goal updated, related activity) older than ${STALLED_DAYS} days` },
      interpretation: "Interpretation: personal projects stall silently because nothing external pushes them. Naming the next concrete step is usually enough to restart.",
      evidence: related.slice(-3).map(evidenceOf),
      range_start: new Date(cutoff).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: related.length ? 0.6 : 0.4,
      limitations: "Activity is inferred from keyword-matched calendar/email/notes; offline progress is invisible.",
      severity: "low",
      proposed_mission: { title: `Next step for ${g.name}`, goal: `Propose the single next concrete action for "${g.name}" with a suggested date; the owner decides.` },
      goal_id: g.id,
    });
  }
  return out;
}

/** Personal recurring charges (Plaid) that renew within RENEWAL_LOOKAHEAD_DAYS. */
export function personalRenewalDue(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const tx = rows.filter((r) => r.provider === "plaid" && r.resource_type === "transaction" && !r.metadata.pending && num(r.metadata.amount) > 0 && str(r.metadata.direction) !== "inflow" && isPersonalRow(r, ctx));
  const byMerchant = new Map<string, SourceRow[]>();
  for (const r of tx) {
    const k = str(r.metadata.merchant_key) ?? (r.title ?? "").toLowerCase();
    if (k) byMerchant.set(k, [...(byMerchant.get(k) ?? []), r]);
  }
  const out: CandidateFinding[] = [];
  for (const [merchant, list] of byMerchant) {
    const sorted = list.map((r) => ({ r, at: tsOf(r) ?? 0 })).filter((x) => x.at).sort((a, b) => a.at - b.at);
    if (sorted.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i]!.at - sorted[i - 1]!.at) / DAY);
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (avgGap < 25 || avgGap > 400) continue;
    const last = sorted.at(-1)!;
    const nextAt = last.at + avgGap * DAY;
    const days = Math.round((nextAt - now) / DAY);
    if (days < 0 || days > RENEWAL_LOOKAHEAD_DAYS) continue;
    const cur = (str(last.r.metadata.currency) ?? "USD").toUpperCase();
    const amt = Math.abs(num(last.r.metadata.amount));
    out.push({
      fingerprint: `personal_renewal_due:${merchant}:${new Date(nextAt).toISOString().slice(0, 7)}`,
      category: "personal_renewal_due",
      title: `${str(last.r.metadata.merchant_name) ?? last.r.title} renews in ${days} day${days === 1 ? "" : "s"} (~${money(amt, cur)})`,
      observed_facts: [`${sorted.length} charges on record, about every ${Math.round(avgGap)} days; last ${new Date(last.at).toISOString().slice(0, 10)} for ${money(amt, cur)}.`],
      metrics: { cadence_days: Math.round(avgGap), last_amount_minor: amt, expected_on: new Date(nextAt).toISOString().slice(0, 10), days_until: days, currency: cur, formula: "last charge + average gap" },
      interpretation: "Interpretation: a personal renewal you can still decide on before it bills. Nothing is inferred about whether you use it.",
      evidence: sorted.slice(-2).map((x) => evidenceOf(x.r)),
      range_start: new Date(sorted[0]!.at).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.6,
      limitations: "Personal classification is keyword/tag based; cadence is an average of past gaps.",
      severity: "info",
      proposed_mission: null,
    });
  }
  return out;
}
