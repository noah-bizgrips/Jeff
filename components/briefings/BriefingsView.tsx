"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState } from "@/components/jeff/shared";
import type { BriefingSummary, BriefingItem } from "@/lib/jeff/briefings/schema";

export interface BriefingListItem {
  id: string;
  kind: "daily" | "weekly" | "monthly";
  period_start: string;
  period_end: string;
  timezone: string;
  title: string;
  sections: BriefingSummary;
  model: string | null;
  status: "generated" | "read" | "saved";
  read_at: string | null;
  saved: boolean;
  created_at: string;
}

const KIND_LABEL = { daily: "Daily brief", weekly: "Weekly review", monthly: "Monthly review" } as const;

function refHref(i: BriefingItem): string | null {
  if (!i.ref_id) return null;
  if (i.ref_kind === "goal") return `/goals#${i.ref_id}`;
  if (i.ref_kind === "finding") return "/insights";
  if (i.ref_kind === "alert") return "/alerts";
  if (i.ref_kind === "mission") return "/missions";
  if (i.ref_kind === "commitment") return "/";
  return null;
}

export function BriefingsView({ initial }: { initial: BriefingListItem[] }) {
  const jeff = useJeff();
  const [items, setItems] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const selected = items.find((b) => b.id === selectedId) ?? null;

  async function generate(kind: "daily" | "weekly" | "monthly") {
    setBusy(kind);
    try {
      const res = await fetch("/api/briefings/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, force: true }) });
      const data = (await res.json().catch(() => null)) as { briefing?: BriefingListItem; usedModel?: boolean; error?: string } | null;
      if (!res.ok || !data?.briefing) return jeff.toast(`Could not generate (${data?.error ?? res.status}).`);
      setItems((xs) => [data.briefing!, ...xs.filter((x) => x.id !== data.briefing!.id)]);
      setSelectedId(data.briefing.id);
      jeff.toast(`${KIND_LABEL[kind]} generated${data.usedModel ? " with Jeff's AI" : " (deterministic template)"}.`);
    } finally {
      setBusy(null);
    }
  }

  async function mark(b: BriefingListItem, action: "read" | "save" | "unsave") {
    const res = await fetch(`/api/briefings/${b.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    const data = (await res.json().catch(() => null)) as { briefing?: BriefingListItem } | null;
    if (res.ok && data?.briefing) setItems((xs) => xs.map((x) => (x.id === b.id ? { ...x, ...data.briefing! } : x)));
  }

  function select(b: BriefingListItem) {
    setSelectedId(b.id);
    if (b.status === "generated") void mark(b, "read");
  }

  async function createMission(i: BriefingItem) {
    const res = await fetch("/api/missions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: i.title.slice(0, 120), goal: `${i.title}\n\n${i.detail}`.slice(0, 4000) }) });
    if (!res.ok) return jeff.toast("Could not create the mission draft.");
    jeff.toast("Task draft created. Nothing runs until you approve it.");
    jeff.navigate("/missions");
  }

  const s = selected?.sections;

  return (
    <section className="page-view" id="briefingsView">
      <div className="view-toolbar">
        <p>Daily brief at your configured time; weekly and monthly reviews on schedule. Generate one now to see today&apos;s picture.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["daily", "weekly", "monthly"] as const).map((k) => (
            <button key={k} className={`button ${k === "daily" ? "primary" : "secondary"}`} type="button" disabled={busy !== null} onClick={() => generate(k)}>
              {busy === k ? <span className="spinner" /> : <Icon name="refresh" />}
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      <div className="briefing-layout">
        <aside className="briefing-inbox">
          {items.length ? (
            items.map((b) => (
              <button key={b.id} type="button" className={`briefing-row ${b.id === selectedId ? "selected" : ""} ${b.status === "generated" ? "unread" : ""}`} onClick={() => select(b)}>
                <span className="briefing-kind">{KIND_LABEL[b.kind]}</span>
                <strong>{b.title}</strong>
                <small>
                  {new Date(b.created_at).toLocaleString()} · {b.model ? "AI" : "template"}
                  {b.saved ? " · saved" : ""}
                </small>
              </button>
            ))
          ) : (
            <EmptyState icon="inbox" title="No briefings yet.">
              Generate a daily brief, or wait for the scheduled one.
            </EmptyState>
          )}
        </aside>
        <article className="briefing-reader">
          {selected && s ? (
            <>
              <div className="section-heading">
                <h2>{s.title}</h2>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="text-button" type="button" onClick={() => mark(selected, selected.saved ? "unsave" : "save")}>
                    <Icon name="bookmark" />
                    {selected.saved ? "Unsave" : "Save"}
                  </button>
                  <button className="text-button" type="button" onClick={() => jeff.ask(`About my ${selected.kind} briefing "${s.title}": what should I do first and why?`)}>
                    <Icon name="sparkles" />
                    Ask Jeff
                  </button>
                </div>
              </div>
              {s.greeting ? <p className="briefing-greeting">{s.greeting}</p> : null}

              <BriefSection label={`TOP ${s.top_attention.length || ""} THINGS THAT NEED YOUR ATTENTION`.replace("  ", " ")} items={s.top_attention} numbered onMission={createMission} empty="Nothing urgent. Enjoy the quiet." />
              {s.goals.length ? (
                <>
                  <div className="section-label">GOALS</div>
                  <div className="audit-list">
                    {s.goals.map((g) => (
                      <div className="audit-row" key={g.goal_id}>
                        <Icon name="target" />
                        <div>
                          <strong>
                            {g.name} · {g.trajectory}
                          </strong>
                          <p>
                            {g.progress}
                            {g.constraint ? ` · constraint: ${g.constraint}` : ""}
                            {g.change ? ` · ${g.change}` : ""}
                          </p>
                        </div>
                        <Link href={`/goals#${g.goal_id}`} className="text-button">
                          Open
                        </Link>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {selected.kind === "daily" ? <BriefSection label="TODAY" items={s.today} empty="No events or commitments due today in synced data." /> : null}
              {s.changes.length ? <BriefSection label="WHAT CHANGED" items={s.changes} /> : null}
              {s.wins.length || s.misses.length ? (
                <div className="goal-two-col">
                  <div>
                    <div className="section-label">WINS</div>
                    <ul className="checklist">{s.wins.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                  <div>
                    <div className="section-label">MISSED</div>
                    <ul className="checklist">{s.misses.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                </div>
              ) : null}
              <BriefSection label="BUSINESS SIGNALS" items={s.business_signals} empty="No open findings." />
              {s.financial.length ? (
                <>
                  <div className="section-label">FINANCIAL</div>
                  <div className="metric-grid">
                    {s.financial.map((m, i) => (
                      <div className="metric-box" key={i}>
                        <small>{m.label}</small>
                        <strong>{m.value}</strong>
                        <p>{m.change ?? m.note ?? ""}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {s.outcomes.length ? <BriefSection label="DID PREVIOUS CHANGES WORK?" items={s.outcomes} /> : null}
              <BriefSection label="JEFF RECOMMENDS" items={s.recommends} onMission={createMission} empty="No recommendation yet — connect more sources or approve a goal." />
              {s.freshness.length ? (
                <p className="auth-note">
                  Data: {s.freshness.join(" · ")}
                  {s.omitted_count ? ` · ${s.omitted_count} lower-priority item${s.omitted_count === 1 ? "" : "s"} omitted` : ""}
                  {s.applied_preferences.length ? ` · shaped by: ${s.applied_preferences.join(", ")}` : ""}
                </p>
              ) : null}
            </>
          ) : (
            <EmptyState icon="inbox" title="Select a briefing." />
          )}
        </article>
      </div>
    </section>
  );
}

function BriefSection({ label, items, numbered, onMission, empty }: { label: string; items: BriefingItem[]; numbered?: boolean; onMission?: (i: BriefingItem) => void; empty?: string }) {
  if (!items.length && !empty) return null;
  return (
    <>
      <div className="section-label">{label}</div>
      {items.length ? (
        <div className="audit-list">
          {items.map((i, idx) => {
            const href = refHref(i);
            return (
              <div className="audit-row" key={idx}>
                {numbered ? <span className="brief-num">{idx + 1}</span> : <Icon name={i.importance === "urgent" ? "bell" : "info"} />}
                <div>
                  <strong>{i.title}</strong>
                  {i.detail ? <p>{i.detail}</p> : null}
                </div>
                <span style={{ display: "flex", gap: 6 }}>
                  {href ? (
                    <Link href={href} className="text-button">
                      Open
                    </Link>
                  ) : null}
                  {onMission && i.importance === "actionable" ? (
                    <button className="text-button" type="button" onClick={() => onMission(i)}>
                      <Icon name="compose" />
                      Mission
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 12 }}>
          {empty}
        </p>
      )}
    </>
  );
}
