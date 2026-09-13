"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState, ModalHeader } from "@/components/jeff/shared";
import type { ObligationCounts } from "@/lib/jeff/obligations/store";
import type { ObligationEventRow, ObligationRow, ObligationSourceRow } from "@/lib/jeff/obligations/types";

/**
 * Follow-Through — a calm queue of unresolved work. Complete ≠ dismiss ≠ cancel ≠ snooze.
 */

export type ObligationView = ObligationRow & { bucket: string };

const BUCKETS: { id: string; label: string; tone: string; hint: string }[] = [
  { id: "overdue", label: "Overdue", tone: "amber", hint: "Past due and still unresolved." },
  { id: "possibly_complete", label: "Possibly complete", tone: "info", hint: "Jeff found evidence but isn't sure — confirm or reject." },
  { id: "waiting_on_me", label: "Waiting on me", tone: "neutral", hint: "Open and owed by you." },
  { id: "waiting_on_other", label: "Waiting on someone else", tone: "neutral", hint: "Jeff tracks the outstanding time; consider following up." },
  { id: "snoozed", label: "Snoozed", tone: "neutral", hint: "Quiet until the snooze ends." },
];

function fmtDate(iso: string | null, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return iso ? new Intl.DateTimeFormat("en-US", opts).format(new Date(iso)) : "—";
}

function dueLabel(o: ObligationView, now: Date) {
  if (!o.due_at) return "No due date";
  const d = Date.parse(o.due_at);
  const days = Math.floor((now.getTime() - d) / 86400000);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  const ahead = Math.ceil((d - now.getTime()) / 86400000);
  return ahead === 1 ? "Due tomorrow" : `Due in ${ahead} days`;
}

export function FollowThroughView({ initial, counts: initialCounts }: { initial: ObligationView[]; counts: ObligationCounts }) {
  const jeff = useJeff();
  const [rows, setRows] = useState(initial);
  const [counts, setCounts] = useState(initialCounts);
  const [view, setView] = useState<"live" | "done">("live");
  const [done, setDone] = useState<ObligationView[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const now = new Date();

  async function refresh(v: "live" | "done" = view) {
    const res = await fetch(`/api/obligations?view=${v}`, { cache: "no-store" });
    const d = (await res.json().catch(() => null)) as { obligations?: ObligationView[]; counts?: ObligationCounts } | null;
    if (!res.ok || !d?.obligations) return;
    if (v === "done") setDone(d.obligations);
    else setRows(d.obligations);
    if (d.counts) setCounts(d.counts);
  }

  async function act(o: ObligationView, action: Record<string, unknown>, toast: string) {
    setBusy(o.id);
    try {
      const res = await fetch(`/api/obligations/${o.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) return jeff.toast(`Could not update (${d?.error ?? res.status}).`);
      jeff.toast(toast);
      jeff.closeModal();
      await refresh("live");
      if (view === "done") await refresh("done");
    } finally {
      setBusy(null);
    }
  }

  async function addReminder(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (t.length < 3) return;
    setBusy("new");
    try {
      const res = await fetch("/api/obligations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
      const d = (await res.json().catch(() => null)) as { obligation?: ObligationView; interpretation?: { tracking_mode: string; due_at: string | null; completion_strategy: { description: string | null }; ambiguities: string[] }; error?: string } | null;
      if (!res.ok || !d?.obligation) return jeff.toast(`Could not create the reminder (${d?.error ?? res.status}).`);
      setText("");
      const i = d.interpretation;
      jeff.toast(`Tracking "${d.obligation.title}" · ${i?.tracking_mode ?? "once"}${i?.due_at ? ` · due ${fmtDate(i.due_at)}` : ""}${i?.ambiguities?.length ? ` · ${i.ambiguities[0]}` : ""}`);
      await refresh("live");
    } finally {
      setBusy(null);
    }
  }

  function snoozeMenu(o: ObligationView) {
    const opts: [string, number][] = [
      ["Later today (+4h)", 4],
      ["Tomorrow morning", 24],
      ["In 3 days", 72],
      ["Next week", 168],
    ];
    jeff.openModal(
      <>
        <ModalHeader title={`Snooze "${o.title}"`} desc="No reminders until then. Tracking resumes afterwards — nothing is marked done." eyebrow="FOLLOW-THROUGH" />
        <div className="modal-body">
          <div className="document-list">
            {opts.map(([label, h]) => (
              <button key={label} type="button" className="button secondary" onClick={() => act(o, { action: "snooze", until: new Date(Date.now() + h * 3_600_000).toISOString() }, `Snoozed until ${fmtDate(new Date(Date.now() + h * 3_600_000).toISOString(), { month: "short", day: "numeric", hour: "numeric" })}.`)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </>,
    );
  }

  function openDetail(o: ObligationView) {
    jeff.openModal(<ObligationModal o={o} onAct={act} onSnooze={snoozeMenu} busy={busy === o.id} />);
  }

  const groups = BUCKETS.map((b) => ({ ...b, items: rows.filter((o) => o.bucket === b.id) }));
  const unresolved = counts.live - counts.snoozed;

  return (
    <section className="page-view" id="followThroughView">
      <div className="preview-banner">
        <Icon name="refresh" />
        <span>
          <strong>{unresolved} unresolved</strong> · {counts.overdue} overdue · {counts.waiting_on_other} waiting on someone else · {counts.possibly_complete} possible completion{counts.possibly_complete === 1 ? "" : "s"}. A reminder is resolved when the thing actually happens — not when it was shown.
        </span>
      </div>

      <form className="composer" onSubmit={addReminder} style={{ marginBottom: 16 }}>
        <textarea rows={2} maxLength={1000} placeholder="Remind me tomorrow to send Brian the proposal, and keep reminding me until I actually do it…" aria-label="New reminder" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="composer-tools">
          <span>
            <Icon name="sparkles" />
            Jeff infers the due date, persistence and what counts as done.
          </span>
          <button className="send-button" type="submit" aria-label="Add reminder" disabled={busy === "new"}>
            <Icon name="plus" />
          </button>
        </div>
      </form>

      <div className="filter-tabs">
        <button type="button" className={`filter-tab ${view === "live" ? "active" : ""}`} onClick={() => setView("live")}>
          Open ({counts.live})
        </button>
        <button
          type="button"
          className={`filter-tab ${view === "done" ? "active" : ""}`}
          onClick={async () => {
            setView("done");
            if (!done) await refresh("done");
          }}
        >
          Done recently
        </button>
      </div>

      {view === "live" ? (
        rows.length ? (
          groups.map((g) =>
            g.items.length ? (
              <div key={g.id} className="focus-col" style={{ marginBottom: 18 }}>
                <div className="section-label" title={g.hint}>
                  {g.label.toUpperCase()} ({g.items.length})
                </div>
                {g.items.map((o) => (
                  <div key={o.id} className="focus-row static ft-row">
                    <span className={`pill ${o.bucket === "overdue" ? "amber" : o.bucket === "possibly_complete" ? "info" : "neutral"}`}>{o.bucket === "possibly_complete" ? "confirm" : o.bucket === "overdue" ? "overdue" : o.bucket === "waiting_on_other" ? `waiting on ${o.waiting_on ?? o.counterparty ?? "them"}` : o.bucket === "snoozed" ? "snoozed" : "open"}</span>
                    <button type="button" className="focus-copy ft-open" onClick={() => openDetail(o)}>
                      <strong>{o.title}</strong>
                      <small>
                        {o.bucket === "snoozed" ? `Until ${fmtDate(o.snoozed_until, { month: "short", day: "numeric", hour: "numeric" })}` : dueLabel(o, now)}
                        {o.tracking_mode !== "once" ? ` · ${o.tracking_mode}` : ""}
                        {o.reminder_count ? ` · reminded ${o.reminder_count}×` : ""}
                        {o.related_goal_id ? " · linked to a goal" : ""}
                        {o.bucket === "possibly_complete" && o.completion_question ? ` · ${o.completion_question}` : ""}
                      </small>
                    </button>
                    <span className="ft-actions">
                      {o.bucket === "possibly_complete" ? (
                        <>
                          <button className="button secondary" type="button" disabled={busy === o.id} onClick={() => act(o, { action: "confirm_complete" }, "Confirmed complete.")}>
                            Yes, done
                          </button>
                          <button className="button secondary" type="button" disabled={busy === o.id} onClick={() => act(o, { action: "not_complete" }, "Kept open — Jeff will keep tracking it.")}>
                            No
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="button secondary" type="button" disabled={busy === o.id} onClick={() => act(o, { action: "complete" }, "Marked done.")}>
                            <Icon name="check" />
                            Done
                          </button>
                          <button className="button secondary" type="button" disabled={busy === o.id} onClick={() => snoozeMenu(o)}>
                            Snooze
                          </button>
                        </>
                      )}
                      <button className="button secondary" type="button" disabled={busy === o.id} onClick={() => act(o, { action: "dismiss" }, "Dismissed — no longer tracked (not marked done).")} title="Stop tracking without marking done">
                        Dismiss
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null,
          )
        ) : (
          <EmptyState icon="check" title="Nothing unresolved.">Add a reminder above, or let Jeff pick up commitments and tasks from your connected sources.</EmptyState>
        )
      ) : (done ?? []).length ? (
        <div className="audit-list">
          {(done ?? []).map((o) => (
            <div className="audit-row" key={o.id}>
              <Icon name={o.status === "completed" ? "check" : "x"} />
              <div>
                <strong>{o.title}</strong>
                <p>
                  {o.status}
                  {o.status === "completed" && o.completion_evidence.length ? ` · evidence: ${o.completion_evidence[0]!.reason}` : o.status === "completed" ? " · marked by you" : ""}
                </p>
              </div>
              <span>
                {fmtDate(o.completed_at ?? o.dismissed_at ?? o.cancelled_at)}
                <button className="text-button" type="button" style={{ marginLeft: 8 }} onClick={() => act(o, { action: "reopen" }, "Reopened.")}>
                  Reopen
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="Nothing finished yet.">Completed, dismissed and cancelled obligations show here with their evidence.</EmptyState>
      )}
    </section>
  );
}

function ObligationModal({ o, onAct, onSnooze, busy }: { o: ObligationView; onAct: (o: ObligationView, action: Record<string, unknown>, toast: string) => Promise<void>; onSnooze: (o: ObligationView) => void; busy: boolean }) {
  const jeff = useJeff();
  const [detail, setDetail] = useState<{ events: ObligationEventRow[]; sources: ObligationSourceRow[]; explanation: string } | null>(null);
  if (!detail) {
    fetch(`/api/obligations/${o.id}`)
      .then((r) => r.json())
      .then((d: { events?: ObligationEventRow[]; sources?: ObligationSourceRow[]; explanation?: string }) => setDetail({ events: d.events ?? [], sources: d.sources ?? [], explanation: d.explanation ?? "" }))
      .catch(() => setDetail({ events: [], sources: [], explanation: "" }));
  }
  const why =
    o.origin === "jeff" ? "You asked Jeff to track it." : o.origin === "commitment" ? "Jeff found this promise in your messages." : o.origin === "portal" ? "An overdue task in the client portal." : o.origin === "notion" ? "A task in Notion." : o.origin === "calendar" ? "A deadline-style calendar event." : `From ${o.origin}.`;
  return (
    <>
      <ModalHeader title={o.title} desc={why} eyebrow={`FOLLOW-THROUGH · ${o.bucket.replace(/_/g, " ").toUpperCase()}`} />
      <div className="modal-body">
        {o.description ? <p className="detail-content">{o.description}</p> : null}
        <dl className="kv">
          <dt>Status</dt>
          <dd>{o.status.replace(/_/g, " ")}</dd>
          <dt>Due</dt>
          <dd>{o.due_at ? fmtDate(o.due_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "No due date"}</dd>
          <dt>Created</dt>
          <dd>{fmtDate(o.created_at)}</dd>
          <dt>Tracking</dt>
          <dd>{o.tracking_mode}{o.priority !== "normal" ? ` · ${o.priority} priority` : ""}</dd>
          <dt>Owner</dt>
          <dd>{o.assigned_to === "other" ? `Waiting on ${o.waiting_on ?? o.counterparty ?? "someone else"}` : "You"}</dd>
          <dt>Counts as done</dt>
          <dd>{o.completion_strategy.description ?? o.completion_strategy.kind.replace(/_/g, " ")}</dd>
          <dt>Reminders</dt>
          <dd>
            {o.reminder_count} sent{o.last_reminded_at ? ` · last ${fmtDate(o.last_reminded_at, { month: "short", day: "numeric", hour: "numeric" })}` : ""}
            {o.next_reminder_at ? ` · next ${fmtDate(o.next_reminder_at, { month: "short", day: "numeric", hour: "numeric" })}` : ""}
          </dd>
          {o.related_goal_id ? (
            <>
              <dt>Goal</dt>
              <dd>
                <Link href={`/goals#${o.related_goal_id}`}>Linked goal</Link>
              </dd>
            </>
          ) : null}
          {o.related_mission_id ? (
            <>
              <dt>Mission</dt>
              <dd>
                <Link href="/missions">Linked mission</Link>
              </dd>
            </>
          ) : null}
          {o.source_url ? (
            <>
              <dt>Source</dt>
              <dd>
                <a href={o.source_url} target="_blank" rel="noopener noreferrer">
                  Open original
                </a>
              </dd>
            </>
          ) : null}
        </dl>
        {o.completion_question ? (
          <div className="callout">
            <strong>{o.completion_question}</strong>
            <div className="connection-actions" style={{ marginTop: 8 }}>
              <button className="button primary" type="button" disabled={busy} onClick={() => onAct(o, { action: "confirm_complete" }, "Confirmed complete.")}>
                Yes, that completed it
              </button>
              <button className="button secondary" type="button" disabled={busy} onClick={() => onAct(o, { action: "not_complete" }, "Kept open.")}>
                No, keep tracking
              </button>
            </div>
          </div>
        ) : null}
        {o.completion_evidence.length ? (
          <>
            <div className="section-label">COMPLETION EVIDENCE</div>
            <ul className="checklist">
              {o.completion_evidence.map((e, i) => (
                <li key={i}>
                  <Icon name="check" />
                  {e.reason} ({e.provider}
                  {e.title ? `: ${e.title}` : ""}){e.url ? (
                    <>
                      {" "}
                      <a href={e.url} target="_blank" rel="noopener noreferrer">
                        open
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            {detail?.explanation ? <p className="auth-note">{detail.explanation}</p> : null}
          </>
        ) : null}
        <div className="section-label">TIMELINE</div>
        <div className="audit-list">
          {(detail?.events ?? []).length ? (
            (detail?.events ?? []).slice(0, 12).map((e) => (
              <div className="audit-row" key={e.id}>
                <Icon name="refresh" />
                <div>
                  <strong>{e.kind.replace(/_/g, " ")}</strong>
                  <p>{typeof e.payload.reason === "string" ? String(e.payload.reason) : typeof e.payload.importance === "string" ? `importance ${e.payload.importance}` : ""}</p>
                </div>
                <span>{fmtDate(e.created_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </div>
            ))
          ) : (
            <div className="audit-row">
              <p>{detail ? "No events yet." : "Loading…"}</p>
            </div>
          )}
        </div>
        {(detail?.sources ?? []).length > 1 ? <p className="auth-note">Also found in: {(detail?.sources ?? []).map((s) => s.provider).join(", ")}.</p> : null}
        <div className="section-label">TRACKING MODE</div>
        <div className="connection-actions">
          {(["once", "persistent", "important", "critical"] as const).map((m) => (
            <button key={m} type="button" className={`button ${o.tracking_mode === m ? "primary" : "secondary"}`} disabled={busy} onClick={() => onAct(o, { action: "set_tracking_mode", tracking_mode: m }, `Tracking mode: ${m}.`)}>
              {m}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={jeff.closeModal}>
            Close
          </button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => jeff.ask(`About my reminder "${o.title}": what's the status and what evidence do you see?`)}>
            Ask Jeff
          </button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => onSnooze(o)}>
            Snooze
          </button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => onAct(o, { action: "cancel" }, "Cancelled — no longer required.")}>
            Cancel task
          </button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => onAct(o, { action: "stop_tracking" }, "Stopped tracking (not marked done).")}>
            Stop tracking
          </button>
          <button className="button primary" type="button" disabled={busy} onClick={() => onAct(o, { action: "complete" }, "Marked done.")}>
            <Icon name="check" />
            Mark done
          </button>
        </div>
      </div>
    </>
  );
}
