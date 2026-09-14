"use client";

import { noteAttention } from "@/lib/jeff/attention/client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState, ModalHeader } from "@/components/jeff/shared";

export interface AlertItem {
  id: string;
  fingerprint: string;
  kind: "finding" | "goal" | "commitment" | "system" | "obligation" | "group";
  ref_id: string | null;
  importance: "informational" | "briefing" | "important" | "urgent" | "actionable";
  scope: "business" | "personal" | "financial" | "all";
  category: string | null;
  title: string;
  summary: string | null;
  evidence: unknown[];
  status: "open" | "acknowledged" | "snoozed" | "dismissed" | "resolved" | "grouped";
  snoozed_until: string | null;
  deferred_until: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  rule_trace: Record<string, unknown>;
  group_id?: string | null;
}

export interface GroupMemberItem {
  title: string;
  due_at: string | null;
  days_overdue: number | null;
  owner: string | null;
  priority: string | null;
  status: string | null;
  notes: string | null;
  blocking: boolean;
  stage: string | null;
  url: string | null;
}

export interface GroupMember {
  id: string;
  member_kind: "alert" | "finding" | "obligation" | "commitment";
  member_id: string;
  alert_id: string | null;
  title: string;
  status: "live" | "resolved";
  key_source: "structured" | "semantic";
  detail: {
    kind: string;
    category: string | null;
    due_at: string | null;
    days_overdue: number | null;
    owner: string | null;
    priority: string | null;
    status: string | null;
    notes: string | null;
    blocking: boolean;
    source: string | null;
    href: string;
    items?: GroupMemberItem[];
    count?: number;
  };
}

export interface AlertGroupItem {
  id: string;
  entity_kind: "client" | "project" | "goal" | "mission" | "contact" | "campaign" | "workflow" | "issue" | "category";
  entity_name: string;
  issue_kind: string;
  title: string;
  summary: string | null;
  interpretation: string | null;
  facts: { member_count?: number; record_count?: number; oldest_overdue_days?: number | null; primary_blocker?: string | null; owner_split?: { bizgrips: number; client: number; you: number; other: number }; sources?: string[] };
  importance: AlertItem["importance"];
  status: "open" | "acknowledged" | "snoozed" | "dismissed" | "resolved";
  snoozed_until: string | null;
  member_count: number;
  reopened_count: number;
  alert_id: string | null;
  first_seen: string;
  last_seen: string;
  members: GroupMember[];
}

type Filter = "urgent" | "important" | "briefing" | "resolved" | "goal" | "financial" | "operations" | "clients" | "acquisition" | "personal";

const FILTERS: [Filter, string][] = [
  ["urgent", "Urgent"],
  ["important", "Important"],
  ["briefing", "Briefing"],
  ["resolved", "Resolved"],
  ["goal", "Goal-related"],
  ["financial", "Financial"],
  ["operations", "Operations"],
  ["clients", "Clients"],
  ["acquisition", "Acquisition"],
  ["personal", "Personal"],
];

const CLIENT = new Set(["lead_followup_gap", "pipeline_aging", "commitment_owed_by_me", "commitment_owed_to_me", "onboarding_blocker", "delivery", "engagement", "money"]);
const OPS = new Set(["automation_failure", "operational_bottleneck", "automation_opportunity", "missed_commitment", "automation"]);
const ACQ = new Set(["ad_spend_change", "acquisition"]);

function matches(a: AlertItem, f: Filter | null): boolean {
  // Members of an open group live inside the group card, never as their own row.
  if (a.status === "grouped") return false;
  if (!f) return a.status !== "resolved" && a.status !== "dismissed";
  switch (f) {
    case "urgent":
      return a.importance === "urgent" && ["open", "acknowledged"].includes(a.status);
    case "important":
      return ["important", "actionable"].includes(a.importance) && ["open", "acknowledged"].includes(a.status);
    case "briefing":
      return ["briefing", "informational"].includes(a.importance) && ["open", "acknowledged"].includes(a.status);
    case "resolved":
      return a.status === "resolved" || a.status === "dismissed";
    case "goal":
      return a.kind === "goal" || (a.kind === "group" && a.category === "goal");
    case "financial":
      return a.scope === "financial";
    case "operations":
      return !!a.category && OPS.has(a.category);
    case "clients":
      return !!a.category && CLIENT.has(a.category);
    case "acquisition":
      return !!a.category && ACQ.has(a.category);
    case "personal":
      return a.scope === "personal";
  }
}

const TONE: Record<AlertItem["importance"], string> = { urgent: "danger", important: "amber", actionable: "amber", briefing: "info", informational: "neutral" };

function refHref(a: AlertItem): string | null {
  if (a.kind === "goal" && a.ref_id) return `/goals#${a.ref_id}`;
  if (a.kind === "finding") return "/insights";
  if (a.kind === "commitment") return "/follow-through";
  if (a.kind === "obligation") return "/follow-through";
  return null;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "no due date";
}

/** "Review tasks" goes where most of the group's members live. */
function reviewHref(g: AlertGroupItem): string {
  const counts = new Map<string, number>();
  for (const m of g.members) counts.set(m.detail.href, (counts.get(m.detail.href) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "/insights";
}

function memberLine(m: GroupMember): string {
  const d = m.detail;
  const bits = [d.days_overdue != null && d.days_overdue > 0 ? `${d.days_overdue} day${d.days_overdue === 1 ? "" : "s"} overdue` : d.due_at ? `due ${fmtDate(d.due_at)}` : null, d.owner ? `owner: ${d.owner}` : null, d.priority ? `priority: ${d.priority}` : null, d.status ? d.status.replace(/_/g, " ") : null, d.blocking ? "blocking" : null, m.key_source === "semantic" ? "linked by name" : null].filter(Boolean);
  return bits.join(" · ");
}

function itemLine(it: GroupMemberItem): string {
  return [it.days_overdue != null ? `${it.days_overdue} day${it.days_overdue === 1 ? "" : "s"} overdue` : `due ${fmtDate(it.due_at)}`, it.owner ? `owner: ${it.owner}` : null, it.priority ? `priority: ${it.priority}` : null, it.status ? it.status.replace(/_/g, " ") : null, it.stage ? `stage: ${it.stage}` : null, it.blocking ? "blocking" : null].filter(Boolean).join(" · ");
}

/** Member rows (task, due, days overdue, owner, priority, status, notes) — reused by the card expander and the modal. */
function MemberList({ g, limit }: { g: AlertGroupItem; limit?: number }) {
  const members = limit ? g.members.slice(0, limit) : g.members;
  return (
    <ul className="checklist" style={{ margin: "6px 0 0" }}>
      {members.map((m) => (
        <li key={m.id} style={{ display: "block" }}>
          <div>
            <strong style={{ color: "var(--text-primary)" }}>{m.title}</strong>
            {memberLine(m) ? <span> — {memberLine(m)}</span> : null}
          </div>
          {m.detail.notes ? <div className="muted">{m.detail.notes}</div> : null}
          {m.detail.items?.length ? (
            <ul className="checklist" style={{ margin: "4px 0 0 12px" }}>
              {m.detail.items.slice(0, 15).map((it, i) => (
                <li key={i} style={{ display: "block", padding: "4px 0" }}>
                  {it.url ? (
                    <a href={it.url} target="_blank" rel="noopener noreferrer">
                      {it.title}
                    </a>
                  ) : (
                    it.title
                  )}
                  <span> — {itemLine(it)}</span>
                  {it.notes ? <div className="muted">{it.notes}</div> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
      {limit && g.members.length > limit ? <li className="muted">+{g.members.length - limit} more in Review</li> : null}
    </ul>
  );
}

export function AlertsView({ initial, groups: initialGroups = [] }: { initial: AlertItem[]; groups?: AlertGroupItem[] }) {
  const jeff = useJeff();
  const [alerts, setAlerts] = useState(initial);
  const [groups, setGroups] = useState(initialGroups);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [renderedAt] = useState(() => Date.now());
  const list = useMemo(() => alerts.filter((a) => matches(a, filter)), [alerts, filter]);
  const groupByAlert = useMemo(() => new Map(groups.filter((g) => g.alert_id).map((g) => [g.alert_id as string, g])), [groups]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  function groupFor(a: AlertItem): AlertGroupItem | null {
    if (a.kind !== "group") return null;
    return groupByAlert.get(a.id) ?? (a.ref_id ? (groupById.get(a.ref_id) ?? null) : null);
  }

  async function act(a: AlertItem, body: Record<string, unknown>, okText: string) {
    setBusy(a.id);
    try {
      const res = await fetch(`/api/alerts/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { alert?: AlertItem; rule?: { name: string } | null; suppressed?: number; error?: string } | null;
      if (!res.ok || !data?.alert) return jeff.toast(`Could not update the alert (${data?.error ?? res.status}).`);
      setAlerts((xs) => xs.map((x) => (x.id === a.id ? { ...x, ...data.alert! } : x)));
      void jeff.refreshBrain({ force: true });
      jeff.toast(data.rule ? `${okText} Rule added: "${data.rule.name}"${data.suppressed ? ` (${data.suppressed} findings suppressed)` : ""}. Review under Memory & rules.` : okText);
      jeff.closeModal();
    } finally {
      setBusy(null);
    }
  }

  /** Group lifecycle + draft-only actions go through /api/alert-groups/[id]; the parent alert row follows. */
  async function actGroup(g: AlertGroupItem, body: Record<string, unknown>, okText: string) {
    setBusy(g.id);
    try {
      const res = await fetch(`/api/alert-groups/${g.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { group?: AlertGroupItem; mission?: { id: string; code: string; title: string }; error?: string } | null;
      if (!res.ok || !data?.group) return jeff.toast(`Could not update the group (${data?.error ?? res.status}).`);
      const updated = data.group;
      setGroups((xs) => xs.map((x) => (x.id === g.id ? { ...x, ...updated } : x)));
      if (updated.alert_id) setAlerts((xs) => xs.map((x) => (x.id === updated.alert_id ? { ...x, status: updated.status, snoozed_until: updated.snoozed_until } : x)));
      void jeff.refreshBrain({ force: true });
      jeff.closeModal();
      if (data.mission) {
        jeff.toast(`${okText} Draft ${data.mission.code} created — nothing is sent until you approve it.`);
        jeff.navigate("/missions");
      } else jeff.toast(okText);
    } finally {
      setBusy(null);
    }
  }

  async function prepareFix(a: AlertItem) {
    const res = await fetch("/api/missions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: a.title.slice(0, 120), goal: `${a.title}\n\n${a.summary ?? ""}\n\nPrepare a fix in the sandbox; no production effects.`.slice(0, 4000) }) });
    if (!res.ok) return jeff.toast("Could not create the mission draft.");
    jeff.toast("Task draft created. Nothing runs until you approve it.");
    jeff.closeModal();
    jeff.navigate("/missions");
  }

  async function refresh() {
    setBusy("refresh");
    try {
      const run = await fetch("/api/alerts", { method: "POST" });
      const summary = (await run.json().catch(() => null)) as { created?: number; updated?: number; resolved?: number } | null;
      const [res, gres] = await Promise.all([fetch("/api/alerts", { cache: "no-store" }), fetch("/api/alert-groups", { cache: "no-store" })]);
      const data = (await res.json().catch(() => null)) as { alerts?: AlertItem[] } | null;
      const gdata = (await gres.json().catch(() => null)) as { groups?: AlertGroupItem[] } | null;
      if (data?.alerts) setAlerts(data.alerts);
      if (gdata?.groups) setGroups(gdata.groups);
      void jeff.refreshBrain({ force: true });
      jeff.toast(`Re-evaluated: ${summary?.created ?? 0} new, ${summary?.updated ?? 0} updated, ${summary?.resolved ?? 0} resolved.`);
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openGroup(a: AlertItem, g: AlertGroupItem) {
    const f = g.facts ?? {};
    const split = f.owner_split;
    const splitText = split ? [split.bizgrips ? `${split.bizgrips} owed by BizGrips` : null, split.client ? `${split.client} owed by the client` : null, split.you ? `${split.you} on you` : null, split.other ? `${split.other} waiting on others` : null].filter(Boolean).join(" · ") : "";
    const live = ["open", "acknowledged", "snoozed"].includes(g.status);
    jeff.openModal(
      <>
        <ModalHeader title={g.title} desc={g.summary ?? a.summary ?? ""} eyebrow={`${g.importance.toUpperCase()} · GROUP · ${g.entity_kind.toUpperCase()} · ${g.issue_kind.replace(/_/g, " ")}`} />
        <div className="modal-body">
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              {g.status}
              {g.snoozed_until ? ` until ${new Date(g.snoozed_until).toLocaleString()}` : ""}
              {g.reopened_count ? ` · reopened ${g.reopened_count}×` : ""}
            </dd>
            <dt>Members</dt>
            <dd>
              {g.member_count} related signal{g.member_count === 1 ? "" : "s"}
              {f.record_count && f.record_count !== g.member_count ? ` · ${f.record_count} underlying records` : ""}
              {f.sources?.length ? ` · ${f.sources.join(", ")}` : ""}
            </dd>
            <dt>Oldest overdue</dt>
            <dd>{f.oldest_overdue_days != null && f.oldest_overdue_days > 0 ? `${f.oldest_overdue_days} day${f.oldest_overdue_days === 1 ? "" : "s"}` : "—"}</dd>
            <dt>Primary blocker</dt>
            <dd>{f.primary_blocker ?? "—"}</dd>
            <dt>Owner split</dt>
            <dd>{splitText || "—"}</dd>
            <dt>Seen</dt>
            <dd>
              first {new Date(g.first_seen).toLocaleString()} · last {new Date(g.last_seen).toLocaleString()}
            </dd>
          </dl>
          <div className="section-label">JEFF&apos;S INTERPRETATION</div>
          <p className="muted">{g.interpretation ?? "Deterministic summary only — an interpretation is added when the daily AI budget allows."}</p>
          <div className="section-label">RELATED ITEMS ({g.members.length})</div>
          <MemberList g={g} />
          <div className="modal-actions">
            <Link
              className="button secondary"
              href={reviewHref(g)}
              onClick={() => {
                noteAttention({ kind: "alert_viewed", ref_id: a.id });
                jeff.closeModal();
              }}
            >
              Review tasks <Icon name="arrowUpRight" />
            </Link>
            {live ? (
              <>
                {g.entity_kind === "client" ? (
                  <button className="button secondary" type="button" disabled={busy === g.id} onClick={() => actGroup(g, { action: "remind_client" }, "Reminder drafted.")}>
                    Remind client
                  </button>
                ) : null}
                <button className="button secondary" type="button" disabled={busy === g.id} onClick={() => actGroup(g, { action: "snooze", hours: 24 }, "Snoozed for 24 hours.")}>
                  Snooze 24h
                </button>
                <button className="button secondary" type="button" disabled={busy === g.id} onClick={() => actGroup(g, { action: "dismiss" }, "Dismissed.")}>
                  Dismiss
                </button>
                {g.status !== "acknowledged" ? (
                  <button className="button secondary" type="button" disabled={busy === g.id} onClick={() => actGroup(g, { action: "acknowledge" }, "Acknowledged.")}>
                    Acknowledge
                  </button>
                ) : null}
                <button className="button primary" type="button" disabled={busy === g.id} onClick={() => actGroup(g, { action: "prepare_action" }, "Action drafted.")}>
                  <Icon name="compose" />
                  Prepare action
                </button>
              </>
            ) : (
              <button className="button secondary" type="button" disabled={busy === g.id} onClick={() => actGroup(g, { action: "reopen" }, "Reopened.")}>
                Reopen
              </button>
            )}
          </div>
        </div>
      </>,
    );
  }

  function open(a: AlertItem) {
    const g = groupFor(a);
    if (g) return openGroup(a, g);
    jeff.openModal(
      <>
        <ModalHeader title={a.title} desc={a.summary ?? ""} eyebrow={`${a.importance.toUpperCase()} · ${a.kind.toUpperCase()}${a.category ? ` · ${a.category.replace(/_/g, " ")}` : ""}`} />
        <div className="modal-body">
          <dl className="kv">
            <dt>Status</dt>
            <dd>{a.status}{a.snoozed_until ? ` until ${new Date(a.snoozed_until).toLocaleString()}` : ""}</dd>
            <dt>Seen</dt>
            <dd>
              {a.occurrences}× · first {new Date(a.first_seen).toLocaleString()} · last {new Date(a.last_seen).toLocaleString()}
            </dd>
            <dt>Why this level</dt>
            <dd>{String((a.rule_trace as { base?: string }).base ?? "—")}{Array.isArray((a.rule_trace as { rules?: string[] }).rules) && (a.rule_trace as { rules: string[] }).rules.length ? ` · ${(a.rule_trace as { rules: string[] }).rules.join("; ")}` : ""}</dd>
          </dl>
          {a.evidence.length ? (
            <>
              <div className="section-label">EVIDENCE</div>
              <ul className="checklist">
                {a.evidence.slice(0, 8).map((e, i) => {
                  const ev = e as { title?: string; url?: string; finding_id?: string };
                  return (
                    <li key={i}>
                      {ev.url ? (
                        <a href={ev.url} target="_blank" rel="noopener noreferrer">
                          {ev.title ?? ev.url}
                        </a>
                      ) : (
                        (ev.title ?? ev.finding_id ?? "record")
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          <div className="modal-actions">
            {refHref(a) ? (
              <Link
                className="button secondary"
                href={refHref(a)!}
                onClick={() => {
                  noteAttention({ kind: "alert_viewed", ref_id: a.id });
                  jeff.closeModal();
                }}
              >
                Investigate <Icon name="arrowUpRight" />
              </Link>
            ) : null}
            {["open", "acknowledged"].includes(a.status) ? (
              <>
                <button className="button secondary" type="button" disabled={busy === a.id} onClick={() => act(a, { action: "snooze", hours: 24 }, "Snoozed for 24 hours.")}>
                  Snooze 24h
                </button>
                <button className="button secondary" type="button" disabled={busy === a.id} onClick={() => act(a, { action: "dismiss" }, "Dismissed.")}>
                  Dismiss
                </button>
                {a.kind === "finding" ? (
                  <button className="button secondary" type="button" disabled={busy === a.id} onClick={() => act(a, { action: "mute" }, "Won't show this again.")}>
                    Don&apos;t show this again
                  </button>
                ) : null}
                {a.kind === "finding" ? (
                  <Link className="button secondary" href="/memory" onClick={jeff.closeModal}>
                    Change rule
                  </Link>
                ) : null}
                <button className="button primary" type="button" onClick={() => prepareFix(a)}>
                  <Icon name="compose" />
                  Prepare fix
                </button>
              </>
            ) : (
              <button className="button secondary" type="button" disabled={busy === a.id} onClick={() => act(a, { action: "reopen" }, "Reopened.")}>
                Reopen
              </button>
            )}
          </div>
        </div>
      </>,
    );
  }

  return (
    <section className="page-view" id="alertsView">
      <div className="preview-banner">
        <Icon name="bell" />
        <span>
          <strong>Jeff stays quiet by default.</strong> One alert per condition; repeats bump the count instead of re-notifying. Related signals for the same client, goal or workflow bundle into one group. Rules, quiet hours and your minimum importance shape what appears here.
        </span>
      </div>
      <div className="view-toolbar">
        <div className="filter-tabs" style={{ margin: 0 }}>
          <button type="button" className={`filter-tab ${filter === null ? "active" : ""}`} onClick={() => setFilter(null)}>
            Active
          </button>
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" className={`filter-tab ${filter === id ? "active" : ""}`} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <button className="button secondary" type="button" disabled={busy === "refresh"} onClick={refresh}>
          {busy === "refresh" ? <span className="spinner" /> : <Icon name="refresh" />}
          Re-evaluate
        </button>
      </div>
      <div className="mission-list">
        {list.length ? (
          list.map((a) => {
            const g = groupFor(a);
            return (
              <article className="mission-card" key={a.id}>
                <div className="mission-card-top">
                  <span className="mission-code">
                    {g ? `GROUP / ${g.entity_kind.toUpperCase()} / ${g.issue_kind.replace(/_/g, " ").toUpperCase()}` : `${a.kind.toUpperCase()}${a.category ? ` / ${a.category.replace(/_/g, " ").toUpperCase()}` : ""}`}
                  </span>
                  <span className={`pill ${TONE[a.importance]}`}>{a.importance}</span>
                </div>
                <h3>{a.title}</h3>
                <p>{a.summary}</p>
                {g ? (
                  <>
                    <button className="text-button" type="button" aria-expanded={expanded.has(a.id)} onClick={() => toggle(a.id)}>
                      {expanded.has(a.id) ? "Hide" : "Show"} {g.member_count} related item{g.member_count === 1 ? "" : "s"} <Icon name={expanded.has(a.id) ? "chevrons" : "chevronDown"} />
                    </button>
                    {expanded.has(a.id) ? (
                      <>
                        {g.interpretation ? <p className="muted">{g.interpretation}</p> : null}
                        <MemberList g={g} limit={8} />
                      </>
                    ) : null}
                  </>
                ) : null}
                <div className="mission-card-footer">
                  <span>{g ? `${g.member_count} signals` : `${a.occurrences}×`} · last {new Date(a.last_seen).toLocaleDateString()}</span>
                  {a.status !== "open" ? <span className="permission-tag">{a.status}</span> : null}
                  {a.deferred_until && Date.parse(a.deferred_until) > renderedAt ? <span className="permission-tag">quiet hours</span> : null}
                  <button className="button secondary" type="button" onClick={() => open(a)}>
                    Review <Icon name="arrowUpRight" />
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <EmptyState icon="bell" title={filter ? "Nothing in this filter." : "Nothing needs your attention right now."}>
            {filter ? "Try another filter." : "Alerts appear after syncs and monitors run. Findings below your minimum importance stay in Insights."}
          </EmptyState>
        )}
      </div>
    </section>
  );
}
