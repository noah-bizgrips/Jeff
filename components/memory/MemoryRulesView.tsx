"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState, ModalHeader } from "@/components/jeff/shared";
import type { Memory } from "@/lib/jeff/rules/store";
import type { PresentedRule } from "@/lib/jeff/rules/present";
import type { RuleConflict } from "@/lib/jeff/rules/conflicts";
import { MONITOR_IDS, MONITOR_LABELS, type RuleAction, type RuleCondition } from "@/lib/jeff/rules/schema";

const CATEGORY_LABEL: Record<string, string> = {
  preference: "Preference",
  definition: "Definition",
  working_style: "Working style",
  priority: "Priority",
  dislike: "Dislike",
  business_context: "Business context",
  personal_context: "Personal context",
  communication_style: "Communication",
  exception: "Exception",
};

const SOURCE_LABEL: Record<string, string> = { chat: "Learned from chat", settings: "Added in settings", system: "Jeff default", feedback: "From your feedback" };

function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
}

export function MemoryRulesView({ memories: initialMemories, rules: initialRules, conflicts: initialConflicts }: { memories: Memory[]; rules: PresentedRule[]; conflicts: RuleConflict[] }) {
  const jeff = useJeff();
  const [memories, setMemories] = useState(initialMemories);
  const [rules, setRules] = useState(initialRules);
  const [conflicts, setConflicts] = useState(initialConflicts);

  async function refreshRules() {
    const res = await fetch("/api/rules", { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as { rules: PresentedRule[]; conflicts: RuleConflict[] };
    setRules(d.rules);
    setConflicts(d.conflicts);
  }
  async function refreshMemories() {
    const res = await fetch("/api/memories", { cache: "no-store" });
    if (!res.ok) return;
    setMemories(((await res.json()) as { memories: Memory[] }).memories);
  }

  async function toggleRule(r: PresentedRule) {
    const res = await fetch(`/api/rules/${r.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.pending_confirmation ? { confirm: true } : { enabled: !r.enabled }) });
    const d = (await res.json().catch(() => null)) as { suppressed?: number; error?: string; reason?: string } | null;
    if (!res.ok) return jeff.toast(`Could not update the rule${d?.reason ? `: ${d.reason}` : ""}.`);
    jeff.toast(r.pending_confirmation ? `Rule confirmed and enabled${d?.suppressed ? ` · ${d.suppressed} finding(s) suppressed` : ""}.` : r.enabled ? "Rule disabled. Findings it suppressed stay suppressed until you undo." : `Rule enabled${d?.suppressed ? ` · ${d.suppressed} finding(s) suppressed` : ""}.`);
    await refreshRules();
  }
  async function deleteRule(r: PresentedRule) {
    if (!confirm(`Delete "${r.name}"? Findings it suppressed will be restored.`)) return;
    const res = await fetch(`/api/rules/${r.id}`, { method: "DELETE" });
    if (!res.ok) return jeff.toast("Could not delete the rule.");
    const d = (await res.json()) as { restored: number };
    jeff.toast(`Rule deleted${d.restored ? ` · ${d.restored} finding(s) restored` : ""}.`);
    await refreshRules();
  }
  async function reprocess(r: PresentedRule) {
    const res = await fetch(`/api/rules/${r.id}/reprocess`, { method: "POST" });
    if (!res.ok) return jeff.toast("Reprocess failed.");
    const d = (await res.json()) as { suppressed: number };
    jeff.toast(`${d.suppressed} finding(s) suppressed by "${r.name}".`);
    await refreshRules();
  }
  async function undo(r: PresentedRule) {
    const res = await fetch(`/api/rules/${r.id}/undo`, { method: "POST" });
    if (!res.ok) return jeff.toast("Undo failed.");
    const d = (await res.json()) as { restored: number };
    jeff.toast(`${d.restored} finding(s) restored.`);
    await refreshRules();
  }
  async function deleteMemory(m: Memory) {
    const res = await fetch(`/api/memories?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    if (!res.ok) return jeff.toast("Could not delete the memory.");
    jeff.toast("Forgotten.");
    await refreshMemories();
  }

  const grouped = new Map<string, Memory[]>();
  for (const m of memories.filter((x) => x.active)) grouped.set(m.category, [...(grouped.get(m.category) ?? []), m]);

  return (
    <section className="page-view" id="memoryView">
      <div className="preview-banner">
        <Icon name="info" />
        <span>
          <strong>Jeff stays quiet by default.</strong> Everything here was learned from you or set by you, is inspectable, and can be edited, disabled, or deleted. Security, access, approvals and secrets can never be changed by a learned rule.
        </span>
      </div>

      <div className="view-toolbar">
        <div>
          <span className="mini-eyebrow">MEMORY</span>
          <h3>Jeff remembers…</h3>
        </div>
        <button className="button secondary" type="button" onClick={() => jeff.openModal(<MemoryEditor onSaved={refreshMemories} />)}>
          <Icon name="plus" />
          Add memory
        </button>
      </div>
      {grouped.size ? (
        <div className="security-grid">
          {[...grouped.entries()].map(([cat, items]) => (
            <section className="security-card" key={cat}>
              <h3>{CATEGORY_LABEL[cat] ?? cat}</h3>
              {items.map((m) => (
                <div className="policy-row" key={m.id}>
                  <div>
                    <strong>{m.content}</strong>
                    <small>
                      {m.scope} · {SOURCE_LABEL[m.source] ?? m.source} · {fmtDate(m.created_at)}
                    </small>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="icon-button" type="button" aria-label="Edit memory" onClick={() => jeff.openModal(<MemoryEditor memory={m} onSaved={refreshMemories} />)}>
                      <Icon name="compose" />
                    </button>
                    <button className="icon-button" type="button" aria-label="Forget memory" onClick={() => deleteMemory(m)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <EmptyState icon="layers" title="Nothing remembered yet.">
          Tell Jeff things like “Remember that pipeline value is not revenue” or “I prefer briefs under five items.”
        </EmptyState>
      )}

      <div className="view-toolbar" style={{ marginTop: 24 }}>
        <div>
          <span className="mini-eyebrow">RULES</span>
          <h3>Jeff will…</h3>
        </div>
        <button className="button primary" type="button" onClick={() => jeff.openModal(<RuleEditor onSaved={refreshRules} />)}>
          <Icon name="plus" />
          Add rule
        </button>
      </div>
      {conflicts.length ? (
        <div className="callout">
          <strong>Rule conflicts.</strong>
          <ul className="checklist">
            {conflicts.map((c, i) => (
              <li key={i}>
                “{c.a.name}” vs “{c.b.name}” — {c.reason}
                {c.kind === "needs_clarification" ? " Narrow one of them so Jeff behaves predictably." : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="audit-list">
        {rules.length ? (
          rules.map((r) => (
            <div className="audit-row" key={r.id} style={{ alignItems: "flex-start" }}>
              <Icon name={r.enabled ? "check" : r.pending_confirmation ? "info" : "pause"} />
              <div style={{ flex: 1 }}>
                <strong>{r.name}</strong>
                <p>{r.summary}</p>
                <p style={{ fontSize: 10, color: "var(--muted)" }}>
                  {r.target_label} · {SOURCE_LABEL[r.source] ?? r.source} · created {fmtDate(r.created_at)} · triggered {r.trigger_count} time{r.trigger_count === 1 ? "" : "s"}
                  {r.last_triggered_at ? ` · last ${fmtDate(r.last_triggered_at)}` : ""} · tier {r.tier}
                </p>
                <div className="connection-actions" style={{ marginTop: 6 }}>
                  <button className="button secondary" type="button" onClick={() => toggleRule(r)}>
                    {r.pending_confirmation ? "Confirm & enable" : r.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="button secondary" type="button" onClick={() => jeff.openModal(<RuleEditor rule={r} onSaved={refreshRules} />)}>
                    Edit
                  </button>
                  <button className="button secondary" type="button" onClick={() => jeff.openModal(<RuleHistory rule={r} />)}>
                    History
                  </button>
                  {r.enabled && (r.action.type === "exclude" || r.action.type === "suppress_alert") ? (
                    <button className="button secondary" type="button" onClick={() => reprocess(r)}>
                      Reprocess now
                    </button>
                  ) : null}
                  <button className="button secondary" type="button" onClick={() => undo(r)}>
                    Undo suppression
                  </button>
                  <button className="button secondary danger-button" type="button" onClick={() => deleteRule(r)}>
                    Delete
                  </button>
                </div>
              </div>
              <span className={`pill ${r.pending_confirmation ? "amber" : r.enabled ? "ok" : "neutral"}`}>{r.pending_confirmation ? "Needs confirmation" : r.enabled ? "Enabled" : "Disabled"}</span>
            </div>
          ))
        ) : (
          <div className="audit-row">
            <p>No rules yet. Tell Jeff in chat what to ignore or escalate, or add one here.</p>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function MemoryEditor({ memory, onSaved }: { memory?: Memory; onSaved: () => Promise<void> }) {
  const jeff = useJeff();
  const [content, setContent] = useState(memory?.content ?? "");
  const [category, setCategory] = useState(memory?.category ?? "preference");
  const [scope, setScope] = useState(memory?.scope ?? "business");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = memory
        ? await fetch("/api/memories", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: memory.id, content, category, scope }) })
        : await fetch("/api/memories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, category, scope }) });
      if (!res.ok) return jeff.toast("Could not save the memory.");
      await onSaved();
      jeff.closeModal();
      jeff.toast(memory ? "Memory updated." : "Remembered.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ModalHeader title={memory ? "Edit memory" : "Remember something"} desc="Soft memories shape how Jeff interprets and prioritises. They never override security." eyebrow="MEMORY" />
      <form className="modal-body form-grid" onSubmit={submit}>
        <label className="field">
          What should Jeff remember?
          <textarea value={content} onChange={(e) => setContent(e.target.value)} maxLength={1000} required placeholder="Pipeline value is not revenue." />
        </label>
        <label className="field">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as Memory["category"])}>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value as Memory["scope"])}>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
            <option value="financial">Financial</option>
            <option value="all">All</option>
          </select>
        </label>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </>
  );
}

const ACTIONS: { value: RuleAction["type"]; label: string }[] = [
  { value: "exclude", label: "Ignore (exclude from findings)" },
  { value: "include", label: "Always include (exception to a broader rule)" },
  { value: "suppress_alert", label: "Keep the finding but never alert" },
  { value: "set_severity", label: "Set severity" },
  { value: "escalate", label: "Escalate importance" },
  { value: "require_min_confidence", label: "Require minimum confidence" },
];

export function RuleEditor({ rule, proposed, onSaved, targetJob }: { rule?: PresentedRule; proposed?: { name: string; target_monitor: string | null; conditions: RuleCondition; action: RuleAction; description?: string }; onSaved: () => Promise<void>; /** Scope a new rule to one of Jeff's Jobs (slug); global monitors ignore it. */ targetJob?: string }) {
  const jeff = useJeff();
  const seed = rule ?? proposed;
  const [name, setName] = useState(seed?.name ?? "");
  const [target, setTarget] = useState<string>(seed?.target_monitor ?? "");
  const [sourceType, setSourceType] = useState<string>(seed?.conditions.source_type ?? "");
  const [senders, setSenders] = useState((seed?.conditions.sender_matches ?? []).join(", "));
  const [domains, setDomains] = useState((seed?.conditions.sender_domain ?? []).join(", "));
  const [authorTypes, setAuthorTypes] = useState<string[]>(seed?.conditions.author_type ?? []);
  const [subjects, setSubjects] = useState((seed?.conditions.subject_patterns ?? []).join(", "));
  const [amountMin, setAmountMin] = useState(seed?.conditions.amount_min != null ? String(seed.conditions.amount_min / 100) : "");
  const [amountMax, setAmountMax] = useState(seed?.conditions.amount_max != null ? String(seed.conditions.amount_max / 100) : "");
  const [actionType, setActionType] = useState<RuleAction["type"]>(seed?.action.type ?? "exclude");
  const [severity, setSeverity] = useState("medium");
  const [level, setLevel] = useState("important");
  const [minConf, setMinConf] = useState("0.45");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildConditions(): RuleCondition {
    // Conditions the form does not edit (monitor lists, client-lead flags, tags, metadata…) survive an edit.
    const managed = new Set(["source_type", "sender_matches", "sender_domain", "author_type", "subject_patterns", "amount_min", "amount_max"]);
    const c: RuleCondition = Object.fromEntries(Object.entries(seed?.conditions ?? {}).filter(([k]) => !managed.has(k))) as RuleCondition;
    if (sourceType) c.source_type = sourceType as RuleCondition["source_type"];
    const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    if (list(senders).length) c.sender_matches = list(senders);
    if (list(domains).length) c.sender_domain = list(domains);
    if (authorTypes.length) c.author_type = authorTypes as RuleCondition["author_type"];
    if (list(subjects).length) c.subject_patterns = list(subjects);
    if (amountMin) c.amount_min = Math.round(Number(amountMin) * 100);
    if (amountMax) c.amount_max = Math.round(Number(amountMax) * 100);
    return c;
  }
  function buildAction(): RuleAction {
    if (actionType === "set_severity") return { type: "set_severity", severity: severity as "info" | "low" | "medium" | "high" };
    if (actionType === "escalate") return { type: "escalate", level: level as "important" | "urgent" | "briefing" | "informational" | "actionable" };
    if (actionType === "set_importance") return { type: "set_importance", level: level as "important" | "urgent" | "briefing" | "informational" | "actionable" };
    if (actionType === "require_min_confidence") return { type: "require_min_confidence", value: Number(minConf) };
    return { type: actionType } as RuleAction;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { name, target_monitor: target || null, conditions: buildConditions(), action: buildAction(), rule_type: actionType === "suppress_alert" || actionType === "escalate" ? "alert_policy" : "monitor_filter", target_system: actionType === "suppress_alert" || actionType === "escalate" ? "alerts" : "monitors" };
      const res = rule
        ? await fetch(`/api/rules/${rule.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: payload.name, target_monitor: payload.target_monitor, conditions: payload.conditions, action: payload.action, rule_type: payload.rule_type }) })
        : await fetch("/api/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, description: proposed?.description, target_job: targetJob ?? null }) });
      const d = (await res.json().catch(() => null)) as { error?: string; reason?: string; suppressed?: number } | null;
      if (!res.ok) return setError(d?.reason ?? d?.error ?? `HTTP ${res.status}`);
      await onSaved();
      jeff.closeModal();
      jeff.toast(rule ? "Rule updated." : `Rule added${d?.suppressed ? ` · ${d.suppressed} finding(s) suppressed` : ""}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ModalHeader title={rule ? "Edit rule" : "Add rule"} desc="Rules are deterministic configuration. Narrow rules beat broad suppression." eyebrow="OPERATING RULE" />
      <form className="modal-body form-grid" onSubmit={submit}>
        {error ? <div className="auth-error">{error}</div> : null}
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={140} placeholder="Ignore GitHub repo notifications in Open commitments" />
        </label>
        <label className="field">
          Applies to
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">All monitors</option>
            {MONITOR_IDS.map((id) => (
              <option key={id} value={id}>
                {MONITOR_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Source type
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
            <option value="">Any</option>
            {["email", "message", "contact", "opportunity", "event", "file", "charge", "invoice", "transaction", "subscription"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Senders (comma separated: address, *@domain, or domain)
          <input value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="notifications@github.com, *@github.com" />
        </label>
        <label className="field">
          Sender domains
          <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="vercel.com" />
        </label>
        <div className="field">
          Author type
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {["human", "bot", "system"].map((t) => (
              <label key={t} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={authorTypes.includes(t)} onChange={(e) => setAuthorTypes((a) => (e.target.checked ? [...a, t] : a.filter((x) => x !== t)))} /> {t}
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          Subject patterns (comma separated; * wildcard)
          <input value={subjects} onChange={(e) => setSubjects(e.target.value)} placeholder="^[*]*, *deployment*" />
        </label>
        <div className="form-grid form-grid-2">
          <label className="field">
            Amount ≥ ($)
            <input value={amountMin} onChange={(e) => setAmountMin(e.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            Amount ≤ ($)
            <input value={amountMax} onChange={(e) => setAmountMax(e.target.value)} inputMode="decimal" />
          </label>
        </div>
        <label className="field">
          Then
          <select value={actionType} onChange={(e) => setActionType(e.target.value as RuleAction["type"])}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        {actionType === "set_severity" ? (
          <label className="field">
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {["info", "low", "medium", "high"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        ) : null}
        {actionType === "escalate" || actionType === "set_importance" ? (
          <label className="field">
            Importance
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {["informational", "briefing", "important", "urgent", "actionable"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        ) : null}
        {actionType === "require_min_confidence" ? (
          <label className="field">
            Minimum confidence (0–1)
            <input value={minConf} onChange={(e) => setMinConf(e.target.value)} inputMode="decimal" />
          </label>
        ) : null}
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            {rule ? "Save changes" : "Add rule"}
          </button>
        </div>
      </form>
    </>
  );
}

function RuleHistory({ rule }: { rule: PresentedRule }) {
  const jeff = useJeff();
  const [events, setEvents] = useState<{ id: number; effect: string; detail: string | null; monitor: string | null; createdAt: string; findingTitle: string | null }[] | null>(null);
  useEffect(() => {
    fetch(`/api/rules/${rule.id}`)
      .then((r) => r.json())
      .then((d: { events?: typeof events }) => setEvents(d.events ?? []))
      .catch(() => setEvents([]));
  }, [rule.id]);
  return (
    <>
      <ModalHeader title={rule.name} desc={rule.summary} eyebrow={`RULE HISTORY · ${rule.trigger_count} TRIGGERS`} />
      <div className="modal-body">
        <dl className="kv">
          <dt>Created</dt>
          <dd>
            {fmtDate(rule.created_at)} · {SOURCE_LABEL[rule.source] ?? rule.source}
          </dd>
          {rule.source_quote ? (
            <>
              <dt>Your words</dt>
              <dd>“{rule.source_quote}”</dd>
            </>
          ) : null}
          <dt>Last triggered</dt>
          <dd>{fmtDate(rule.last_triggered_at)}</dd>
        </dl>
        <div className="section-label">RECENT DECISIONS</div>
        <div className="audit-list">
          {events === null ? (
            <div className="audit-row">
              <p>Loading…</p>
            </div>
          ) : events.length ? (
            events.map((e) => (
              <div className="audit-row" key={e.id}>
                <Icon name="lock" />
                <div>
                  <strong>{e.effect.replace(/_/g, " ")}</strong>
                  <p>{e.findingTitle ?? e.detail ?? e.monitor ?? ""}</p>
                </div>
                <span>{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))
          ) : (
            <div className="audit-row">
              <p>No decisions recorded yet.</p>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="button primary" type="button" onClick={jeff.closeModal}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}
