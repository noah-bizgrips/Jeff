/**
 * Deterministic brain state aggregator (spec §5–§9, §28–§31).
 *
 * Pure: takes already-loaded, already-filtered application rows and returns
 * the visualization state. No LLM, no I/O. The counts in the status text are
 * exactly the reasons listed, so "3 things need attention" is always
 * explainable by clicking the brain.
 */
import { BRAIN_POLICY, type BrainMode, type BrainUrgency, type SourceTone } from "./policy";
import { CATEGORY_SOURCES, sourceForProvider, sourcesForProvider } from "./sources";

export interface BrainAlertInput {
  id: string;
  kind: string; // finding | goal | commitment | obligation | system
  category: string | null;
  importance: string; // informational | briefing | important | urgent | actionable
  status: string; // open | acknowledged | snoozed | dismissed | resolved
  title: string;
  summary: string | null;
  ref_id: string | null;
  evidence?: { provider?: string; capability?: string | null }[] | null;
  first_seen?: string | null;
}

export interface BrainFindingInput {
  id: string;
  category: string;
  title: string;
  status: string;
  severity: string;
  confidence: number | null;
  metrics?: Record<string, unknown> | null;
  evidence?: { provider?: string; capability?: string | null }[] | null;
  goal_id?: string | null;
  created_at?: string | null;
}

export interface BrainGoalInput {
  id: string;
  name: string;
  status: string; // active | ...
  trajectory: string | null; // on_track | slightly_at_risk | at_risk | severely_at_risk | unknown
  constraint_key?: string | null;
  sources?: string[]; // provider ids the goal's metrics read
}

export interface BrainObligationInput {
  id: string;
  title: string;
  status: string;
  bucket: "overdue" | "waiting_on_me" | "waiting_on_other" | "possibly_complete" | "snoozed" | "done";
  priority: string; // low | normal | high | critical
  scope: string;
  due_at: string | null;
  related_goal_id: string | null;
  related_client_id: string | null;
  has_money: boolean;
  source_provider?: string | null;
}

export interface BrainConnectionInput {
  provider: string;
  capabilities: string[];
  status: string; // connected | limited | error | reconnect_required | paused | ...
  freshness_level: "fresh" | "aging" | "stale" | "never" | "error";
  freshness_text: string;
  age_hours: number | null;
}

export interface BrainJobRunInput {
  job_slug: string;
  job_name: string;
  status: string; // queued | running | succeeded | partial | failed
  mode: string; // test | run | scheduled
  sources: string[]; // provider ids
  finished_at: string | null;
  error?: string | null;
}

export interface BrainStateInput {
  now: Date;
  alerts: BrainAlertInput[];
  findings: BrainFindingInput[];
  goals: BrainGoalInput[];
  obligations: BrainObligationInput[];
  connections: BrainConnectionInput[];
  jobRuns: BrainJobRunInput[];
}

export interface BrainReason {
  id: string;
  kind: "alert" | "goal" | "obligation" | "finding" | "connection" | "job";
  title: string;
  detail: string | null;
  sources: string[];
  href: string;
  tone: SourceTone;
  weight: number;
}

export interface BrainSourceState {
  source: string;
  tone: SourceTone;
  label: string;
  count: number;
  dashed?: boolean;
}

export interface BrainState {
  state: BrainMode;
  urgency: BrainUrgency;
  attentionLevel: number;
  opportunityLevel: number;
  systemHealth: number;
  activityLevel: number;
  primaryStatus: string;
  secondaryStatus: string | null;
  reasonCount: number;
  affectedSources: BrainSourceState[];
  activeSources: string[];
  reasons: { attention: BrainReason[]; opportunities: BrainReason[]; followThrough: BrainReason[]; system: BrainReason[] };
  computedAt: string;
}

const ACTIVE_FINDING_STATUSES = new Set(["new", "open", "acknowledged", "in_progress", "reviewing", "accepted", "action_planned", "action_in_progress", "monitoring"]);
const OPEN_ALERT_STATUSES = new Set(["open"]);
const ATTENTION_IMPORTANCE = new Set(["important", "urgent", "actionable"]);

/** Follow-through items that count toward "things need attention": overdue or due today. */
export function isDueFollowThrough(r: BrainReason): boolean {
  return r.tone === "danger" || !!r.detail?.includes("overdue") || r.detail === "Due today";
}

/** The number the status text shows; the panel lists exactly these items (§15). */
export function attentionCountOf(reasons: { attention: BrainReason[]; followThrough: BrainReason[] }): number {
  return reasons.attention.length + reasons.followThrough.filter(isDueFollowThrough).length;
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function evidenceSources(ev: { provider?: string; capability?: string | null }[] | null | undefined, category: string | null): string[] {
  const out = new Set<string>();
  for (const e of ev ?? []) {
    if (!e?.provider) continue;
    const s = sourceForProvider(e.provider, e.capability ?? null);
    if (s) out.add(s);
  }
  if (!out.size && category) for (const s of CATEGORY_SOURCES[category] ?? []) out.add(s);
  return [...out];
}

function isOpportunityFinding(f: BrainFindingInput): boolean {
  const cat = f.category;
  if (BRAIN_POLICY.opportunityCategories.includes(cat)) return true;
  const m = f.metrics ?? {};
  const theme = typeof m.theme === "string" ? m.theme : null;
  const subtype = typeof m.subtype === "string" ? m.subtype : null;
  if (cat === "blind_spot") {
    if (theme && BRAIN_POLICY.opportunityThemes.includes(theme)) return true;
    if (subtype && BRAIN_POLICY.opportunitySubtypes.some((s) => subtype.includes(s))) return true;
  }
  if (cat === "goal_coach") return true; // coach recommendations are forward-looking, never pressure
  return false;
}

function obligationWeight(o: BrainObligationInput, now: Date): number {
  let w = BRAIN_POLICY.obligationPriorityWeight[o.priority] ?? 0.3;
  if (o.related_goal_id) w += BRAIN_POLICY.obligationGoalBonus;
  if (o.related_client_id) w += BRAIN_POLICY.obligationClientBonus;
  if (o.has_money) w += BRAIN_POLICY.obligationMoneyBonus;
  if (o.bucket === "overdue" && o.due_at) {
    const days = Math.max(0, (now.getTime() - Date.parse(o.due_at)) / 86_400_000);
    w += Math.min(BRAIN_POLICY.obligationOverdueCap, days * BRAIN_POLICY.obligationOverduePerDay);
  }
  // Trivial personal errands never carry business pressure.
  if (o.scope === "personal" && o.priority === "low") w = Math.min(w, BRAIN_POLICY.obligationInclusionFloor - 0.01);
  return clamp01(w);
}

function fmtOverdue(due: string | null, now: Date): string | null {
  if (!due) return null;
  const days = Math.floor((now.getTime() - Date.parse(due)) / 86_400_000);
  if (days < 0) return null; // not yet due
  if (days === 0) return "Due today";
  return `${days} day${days === 1 ? "" : "s"} overdue`;
}

export function computeBrainState(input: BrainStateInput): BrainState {
  const { now } = input;
  const attention: BrainReason[] = [];
  const opportunities: BrainReason[] = [];
  const followThrough: BrainReason[] = [];
  const system: BrainReason[] = [];
  const tones = new Map<string, { tone: SourceTone; count: number; label: string; dashed?: boolean }>();
  const bump = (sources: string[], tone: SourceTone, label: string, dashed = false) => {
    const rank: Record<SourceTone, number> = { danger: 5, warning: 4, stale: 3, opportunity: 2, active: 1, neutral: 0 };
    for (const s of sources) {
      const cur = tones.get(s);
      if (!cur) tones.set(s, { tone, count: 1, label, dashed });
      else {
        cur.count += 1;
        if (rank[tone] > rank[cur.tone]) {
          cur.tone = tone;
          cur.label = label;
          cur.dashed = dashed;
        }
      }
    }
  };

  // ---- Attention: open alerts at important+ (already post-rules, post-lifecycle) ----
  let attentionPressure = 0;
  let urgentCount = 0;
  const seenRefs = new Set<string>();
  for (const a of input.alerts) {
    if (!OPEN_ALERT_STATUSES.has(a.status)) continue;
    if (!ATTENTION_IMPORTANCE.has(a.importance)) continue;
    if (a.kind === "obligation") continue; // obligations are weighted below from their own rows
    const w = BRAIN_POLICY.alertWeight[a.importance] ?? 0;
    attentionPressure += w;
    if (a.importance === "urgent") urgentCount++;
    if (a.ref_id) seenRefs.add(a.ref_id);
    const sources = evidenceSources(a.evidence, a.category);
    const tone: SourceTone = a.importance === "urgent" ? "danger" : "warning";
    bump(sources, tone, a.title);
    attention.push({ id: `alert:${a.id}`, kind: "alert", title: a.title, detail: a.summary, sources, href: "/alerts", tone, weight: w });
  }

  // ---- Attention: goals materially off trajectory (avoid double counting a goal alert) ----
  for (const g of input.goals) {
    if (g.status !== "active") continue;
    const w = BRAIN_POLICY.goalWeight[g.trajectory ?? "unknown"] ?? 0;
    if (w < BRAIN_POLICY.goalWeight.slightly_at_risk!) continue;
    if (seenRefs.has(g.id)) continue;
    attentionPressure += w;
    const sources = (g.sources ?? []).flatMap((p) => sourcesForProvider(p));
    const tone: SourceTone = g.trajectory === "severely_at_risk" ? "danger" : "warning";
    if (w >= BRAIN_POLICY.goalWeight.at_risk!) {
      bump(sources, tone, `${g.name}: ${g.trajectory?.replace(/_/g, " ")}`);
      attention.push({ id: `goal:${g.id}`, kind: "goal", title: g.name, detail: `Goal ${g.trajectory?.replace(/_/g, " ")}${g.constraint_key ? ` · constraint: ${g.constraint_key.replace(/_/g, " ")}` : ""}`, sources, href: "/goals", tone, weight: w });
    }
  }

  // ---- Follow-Through: weighted obligations (trivial ones excluded) ----
  for (const o of input.obligations) {
    if (o.bucket === "done" || o.bucket === "snoozed") continue;
    const w = obligationWeight(o, now);
    if (w < BRAIN_POLICY.obligationInclusionFloor) continue;
    const src = o.source_provider ? sourcesForProvider(o.source_provider) : [];
    const overdue = o.bucket === "overdue";
    const tone: SourceTone = overdue && w >= BRAIN_POLICY.obligationImportantFloor ? "danger" : "warning";
    const detail = o.bucket === "waiting_on_other" ? "Waiting on someone else" : (fmtOverdue(o.due_at, now) ?? (o.bucket === "possibly_complete" ? "Possibly complete — confirm" : "Open"));
    const reason: BrainReason = { id: `obligation:${o.id}`, kind: "obligation", title: o.title, detail, sources: src, href: "/follow-through", tone, weight: w };
    followThrough.push(reason);
    if (overdue || o.bucket === "waiting_on_me") {
      attentionPressure += w;
      if (overdue) bump(src, tone, o.title);
    }
  }

  // ---- Opportunities: forward-looking findings with confidence ----
  let opportunityEnergy = 0;
  for (const f of input.findings) {
    if (!ACTIVE_FINDING_STATUSES.has(f.status)) continue;
    if (!isOpportunityFinding(f)) continue;
    const conf = f.confidence ?? 0.5;
    if (conf < BRAIN_POLICY.opportunityMinConfidence) continue;
    opportunityEnergy += conf;
    const sources = evidenceSources(f.evidence, f.category);
    bump(sources, "opportunity", f.title);
    opportunities.push({ id: `finding:${f.id}`, kind: "finding", title: f.title, detail: f.goal_id ? "Related to an active goal" : null, sources, href: "/insights", tone: "opportunity", weight: conf });
  }

  // ---- System health: connections + freshness + failing jobs ----
  const connected = input.connections.filter((c) => !["paused"].includes(c.status));
  let unhealthy = 0;
  for (const c of connected) {
    const sources = sourcesForProvider(c.provider, c.capabilities);
    const broken = BRAIN_POLICY.degradedStatuses.includes(c.status) || c.freshness_level === "error";
    const stale = c.freshness_level === "stale" || (c.age_hours != null && c.age_hours > BRAIN_POLICY.staleHours);
    if (!broken && !stale) continue;
    unhealthy++;
    const tone: SourceTone = broken ? "danger" : "stale";
    bump(sources, tone, c.freshness_text, true);
    system.push({ id: `connection:${c.provider}`, kind: "connection", title: c.provider === "highlevel" ? "HighLevel" : c.provider.charAt(0).toUpperCase() + c.provider.slice(1), detail: broken ? (c.status === "reconnect_required" ? "Reconnect required" : "Sync error") : c.freshness_text, sources, href: "/connections", tone, weight: broken ? 1 : 0.6 });
  }
  const failedRuns = input.jobRuns.filter((r) => r.status === "failed" && r.finished_at && now.getTime() - Date.parse(r.finished_at) < BRAIN_POLICY.failedRunsWindowHours * 3_600_000);
  const seenJobs = new Set<string>();
  for (const r of failedRuns) {
    if (seenJobs.has(r.job_slug)) continue;
    seenJobs.add(r.job_slug);
    unhealthy++;
    const sources = r.sources.flatMap((p) => sourcesForProvider(p));
    system.push({ id: `job:${r.job_slug}`, kind: "job", title: r.job_name, detail: "Job failed in the last 24h", sources, href: `/jobs/${r.job_slug}`, tone: "warning", weight: 0.5 });
  }
  const healthDenominator = Math.max(1, connected.length + seenJobs.size);
  const systemHealth = clamp01(1 - unhealthy / healthDenominator);

  // ---- Activity: running jobs (server-side signal; client adds ask/scan) ----
  const running = input.jobRuns.filter((r) => r.status === "running" || r.status === "queued");
  const activeSources = [...new Set(running.flatMap((r) => r.sources.flatMap((p) => sourcesForProvider(p))))];
  const activityLevel = running.length ? 1 : 0;
  for (const s of activeSources) if (!tones.has(s)) tones.set(s, { tone: "active", count: 1, label: "In use" });

  // ---- Levels ----
  const attentionLevel = clamp01(attentionPressure / 2.5);
  const opportunityLevel = clamp01(opportunityEnergy / 2);
  const attentionCount = attentionCountOf({ attention, followThrough });

  // ---- Ambient state precedence (§9) ----
  let state: BrainMode = "watching";
  let urgency: BrainUrgency = "normal";
  if (running.length) state = "investigating";
  else if (urgentCount > 0 || attentionLevel >= BRAIN_POLICY.attentionUrgentAt) {
    state = "attention";
    urgency = "urgent";
  } else if (systemHealth <= BRAIN_POLICY.degradedHealthAt && system.length) state = "degraded";
  else if (attentionLevel >= BRAIN_POLICY.attentionImportantAt || attentionCount > 0) {
    state = "attention";
    urgency = "important";
  } else if (opportunityLevel >= BRAIN_POLICY.opportunityAt || opportunities.length > 0) state = "opportunity";

  // ---- Status text (§12) ----
  let primaryStatus = "Watching";
  let secondaryStatus: string | null = "Everything important looks normal";
  const reasonCount = state === "attention" ? attentionCount : state === "opportunity" ? opportunities.length : state === "degraded" ? system.length : 0;
  if (state === "investigating") {
    const n = activeSources.length;
    primaryStatus = "Investigating…";
    secondaryStatus = n ? `Analyzing ${n} source${n === 1 ? "" : "s"}` : running[0]?.job_name ? `Running ${running[0].job_name}` : null;
  } else if (state === "attention") {
    primaryStatus = `${attentionCount} thing${attentionCount === 1 ? "" : "s"} need${attentionCount === 1 ? "s" : ""} attention`;
    const fin = attention.filter((r) => r.sources.some((s) => ["stripe", "plaid"].includes(s))).length;
    const ft = followThrough.filter(isDueFollowThrough).length;
    const biz = attentionCount - fin - ft;
    const parts = [biz > 0 ? `${biz} business` : null, fin > 0 ? `${fin} financial` : null, ft > 0 ? `${ft} follow-through` : null].filter(Boolean);
    secondaryStatus = parts.length ? parts.join(" · ") : null;
  } else if (state === "degraded") {
    primaryStatus = system.length === 1 ? "1 source needs attention" : `${system.length} sources need attention`;
    secondaryStatus = system[0]?.detail ?? "Coverage limited";
  } else if (state === "opportunity") {
    const n = opportunities.length;
    primaryStatus = `${n} opportunit${n === 1 ? "y" : "ies"} found`;
    const goalLinked = opportunities.filter((r) => r.detail).length;
    secondaryStatus = goalLinked ? `${goalLinked} related to active goals` : null;
  } else if (!connected.length) {
    primaryStatus = "Quiet";
    secondaryStatus = "No sources connected yet";
  }
  // Source-level degradation stays visible under other states (§8/§9).
  if (state !== "degraded" && system.length && secondaryStatus == null) secondaryStatus = system[0]!.detail;

  const affectedSources: BrainSourceState[] = [...tones.entries()].map(([source, t]) => ({ source, tone: t.tone, label: t.label, count: t.count, dashed: t.dashed }));

  return {
    state,
    urgency,
    attentionLevel,
    opportunityLevel,
    systemHealth,
    activityLevel,
    primaryStatus,
    secondaryStatus,
    reasonCount,
    affectedSources,
    activeSources,
    reasons: {
      attention: attention.sort((a, b) => b.weight - a.weight),
      opportunities: opportunities.sort((a, b) => b.weight - a.weight),
      followThrough: followThrough.sort((a, b) => b.weight - a.weight),
      system,
    },
    computedAt: now.toISOString(),
  };
}

/** Stripped version sent to the canvas (keeps re-renders cheap). */
export interface BrainStateLite {
  state: BrainMode;
  urgency: BrainUrgency;
  attentionLevel: number;
  opportunityLevel: number;
  systemHealth: number;
  affectedSources: BrainSourceState[];
  activeSources: string[];
  reasonIds: string[];
}

export function liteOf(s: BrainState): BrainStateLite {
  return {
    state: s.state,
    urgency: s.urgency,
    attentionLevel: s.attentionLevel,
    opportunityLevel: s.opportunityLevel,
    systemHealth: s.systemHealth,
    affectedSources: s.affectedSources,
    activeSources: s.activeSources,
    reasonIds: [...s.reasons.attention, ...s.reasons.opportunities, ...s.reasons.followThrough, ...s.reasons.system].map((r) => r.id),
  };
}

export const EMPTY_BRAIN_STATE: BrainState = {
  state: "watching",
  urgency: "normal",
  attentionLevel: 0,
  opportunityLevel: 0,
  systemHealth: 1,
  activityLevel: 0,
  primaryStatus: "Watching",
  secondaryStatus: "Everything important looks normal",
  reasonCount: 0,
  affectedSources: [],
  activeSources: [],
  reasons: { attention: [], opportunities: [], followThrough: [], system: [] },
  computedAt: new Date(0).toISOString(),
};
