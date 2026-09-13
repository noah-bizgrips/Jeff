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
  kind: "finding" | "goal" | "commitment" | "system" | "obligation";
  ref_id: string | null;
  importance: "informational" | "briefing" | "important" | "urgent" | "actionable";
  scope: "business" | "personal" | "financial" | "all";
  category: string | null;
  title: string;
  summary: string | null;
  evidence: unknown[];
  status: "open" | "acknowledged" | "snoozed" | "dismissed" | "resolved";
  snoozed_until: string | null;
  deferred_until: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  rule_trace: Record<string, unknown>;
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

const CLIENT = new Set(["lead_followup_gap", "pipeline_aging", "commitment_owed_by_me", "commitment_owed_to_me", "onboarding_blocker"]);
const OPS = new Set(["automation_failure", "operational_bottleneck", "automation_opportunity", "missed_commitment"]);
const ACQ = new Set(["ad_spend_change"]);

function matches(a: AlertItem, f: Filter | null): boolean {
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
      return a.kind === "goal";
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

export function AlertsView({ initial }: { initial: AlertItem[] }) {
  const jeff = useJeff();
  const [alerts, setAlerts] = useState(initial);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renderedAt] = useState(() => Date.now());
  const list = useMemo(() => alerts.filter((a) => matches(a, filter)), [alerts, filter]);

  async function act(a: AlertItem, body: Record<string, unknown>, okText: string) {
    setBusy(a.id);
    try {
      const res = await fetch(`/api/alerts/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { alert?: AlertItem; rule?: { name: string } | null; suppressed?: number; error?: string } | null;
      if (!res.ok || !data?.alert) return jeff.toast(`Could not update the alert (${data?.error ?? res.status}).`);
      setAlerts((xs) => xs.map((x) => (x.id === a.id ? { ...x, ...data.alert! } : x)));
      jeff.toast(data.rule ? `${okText} Rule added: "${data.rule.name}"${data.suppressed ? ` (${data.suppressed} findings suppressed)` : ""}. Review under Memory & rules.` : okText);
      jeff.closeModal();
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
      const res = await fetch("/api/alerts", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { alerts?: AlertItem[] } | null;
      if (data?.alerts) setAlerts(data.alerts);
      jeff.toast(`Re-evaluated: ${summary?.created ?? 0} new, ${summary?.updated ?? 0} updated, ${summary?.resolved ?? 0} resolved.`);
    } finally {
      setBusy(null);
    }
  }

  function open(a: AlertItem) {
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
          <strong>Jeff stays quiet by default.</strong> One alert per condition; repeats bump the count instead of re-notifying. Rules, quiet hours and your minimum importance shape what appears here.
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
          list.map((a) => (
            <article className="mission-card" key={a.id}>
              <div className="mission-card-top">
                <span className="mission-code">
                  {a.kind.toUpperCase()}
                  {a.category ? ` / ${a.category.replace(/_/g, " ").toUpperCase()}` : ""}
                </span>
                <span className={`pill ${TONE[a.importance]}`}>{a.importance}</span>
              </div>
              <h3>{a.title}</h3>
              <p>{a.summary}</p>
              <div className="mission-card-footer">
                <span>{a.occurrences}× · last {new Date(a.last_seen).toLocaleDateString()}</span>
                {a.status !== "open" ? <span className="permission-tag">{a.status}</span> : null}
                {a.deferred_until && Date.parse(a.deferred_until) > renderedAt ? <span className="permission-tag">quiet hours</span> : null}
                <button className="button secondary" type="button" onClick={() => open(a)}>
                  Review <Icon name="arrowUpRight" />
                </button>
              </div>
            </article>
          ))
        ) : (
          <EmptyState icon="bell" title={filter ? "Nothing in this filter." : "Nothing needs your attention right now."}>
            {filter ? "Try another filter." : "Alerts appear after syncs and monitors run. Findings below your minimum importance stay in Insights."}
          </EmptyState>
        )}
      </div>
    </section>
  );
}
