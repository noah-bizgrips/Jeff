"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Icon, SourceIcon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { DocModal, EmptyState, MemoryRow, ModalHeader } from "@/components/jeff/shared";
import { BrainCanvas, type BrainHandle } from "./BrainCanvas";
import { sourceDef } from "@/lib/jeff/sources";
import { linksFor } from "@/lib/jeff/retrieve";
import { looksSensitiveClient } from "@/lib/security/client-redact";
import type { DemoInsight } from "@/lib/jeff/demo-data";
import { PushPrompt } from "@/components/jeff/PushPrompt";
import { BlindSpotScanButton, JobsStatusLine, type JobsSummary } from "@/components/jobs/BlindSpotScan";

type CommandMode = "prepare" | "ask" | "run";

export interface GoalRiskItem {
  id: string;
  name: string;
  trajectory: string;
  label: string;
  primary: string | null;
  constraint: string | null;
  daysRemaining: number | null;
}

export interface FocusAlert {
  id: string;
  kind: string;
  importance: string;
  title: string;
  summary: string | null;
  occurrences: number;
}
export interface FocusFinding {
  id: string;
  category: string;
  title: string;
  severity: string;
}
export interface FocusToday {
  kind: "event" | "commitment";
  id: string;
  title: string;
  detail: string;
  when: string | null;
  overdue?: boolean;
}
export interface FocusMission {
  id: string;
  code: string;
  title: string;
  status: string;
}
export interface FocusObligation {
  id: string;
  title: string;
  bucket: string;
  due_at: string | null;
  waiting_on: string | null;
  question: string | null;
}

export interface FocusData {
  attention: FocusAlert[];
  opportunities: FocusFinding[];
  today: FocusToday[];
  missions: FocusMission[];
  freshness: string[];
  followThrough?: { unresolved: number; overdue: number; waiting_on_other: number; possibly_complete: number; top: FocusObligation[] };
}

export function MissionControl({ topInsight, goalsAtRisk = [], focus = null, jobs = null }: { topInsight: DemoInsight | null; goalsAtRisk?: GoalRiskItem[]; focus?: FocusData | null; jobs?: JobsSummary | null }) {
  const jeff = useJeff();
  const brain = useRef<BrainHandle>(null);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState<{ title: string; x: number; y: number } | null>(null);
  const [commandMode, setCommandMode] = useState<CommandMode>("prepare");
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const ids = jeff.connectedSources();
  const all = jeff.docs();
  const focused = jeff.focusSource;
  const visible = all.filter((d) => !focused || d.source === focused);

  const anchors = useMemo(() => {
    const positions =
      ids.length <= 6
        ? [
            [0.18, 0.43],
            [0.82, 0.48],
            [0.3, 0.8],
            [0.77, 0.14],
            [0.24, 0.12],
            [0.72, 0.81],
          ]
        : ids.map((_, i) => [0.5 + Math.cos(-Math.PI / 2 + (i * Math.PI * 2) / ids.length) * 0.36, 0.47 + Math.sin(-Math.PI / 2 + (i * Math.PI * 2) / ids.length) * 0.38]);
    return ids.map((id, i) => ({ id, x: positions[i]![0]!, y: positions[i]![1]! }));
  }, [ids]);

  async function submitCommand(e?: FormEvent) {
    e?.preventDefault();
    const text = goal.trim();
    if (commandMode === "ask") {
      setGoal("");
      return jeff.ask(text);
    }
    if (commandMode === "run") {
      jeff.openModal(
        <>
          <ModalHeader title="Approved runs are gated." desc="Running a task needs an approved mission, a verified session, and an enabled worker." eyebrow="EXECUTION" />
          <div className="modal-body">
            <div className="callout">Nothing runs from this box. Create a draft, review it in Missions, and approve the exact version before any worker executes it.</div>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={jeff.closeModal}>
                Close
              </button>
              <Link className="button primary" href="/connections" onClick={jeff.closeModal}>
                Worker setup
              </Link>
            </div>
          </div>
        </>,
      );
      return;
    }
    if (!text) return jeff.toast("Describe what you want Jeff to accomplish.");
    if (looksSensitiveClient(text)) return jeff.toast("Possible secret or private access link detected. Use a non-sensitive description.");
    setSubmitting(true);
    try {
      const res = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: text, worker: /workflow|n8n|lead|report/i.test(text) ? "n8n" : "claude" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        return jeff.toast(`Could not create the draft (${data?.error ?? res.status}).`);
      }
      setGoal("");
      jeff.toast("Task draft created. Nothing runs until you approve it.");
      jeff.navigate("/missions");
    } finally {
      setSubmitting(false);
    }
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return (
    <div className="page-view" id="brainView">
      <section className="mc-greeting" aria-label="Greeting">
        <h1>{greeting}, Noah.</h1>
        <p>{jeff.mode === "live" ? "Here\u2019s what deserves your attention." : "Demo workspace \u2014 sample data only. Switch to Live in the header to see your real connections."}</p>
      </section>
      <div className="preview-banner">
        <Icon name="info" />
        <span>
          {jeff.mode === "demo" ? (
            <>
              <strong>Demo workspace.</strong> Sample data only. Switch to Live in the header to see your real connections.
            </>
          ) : (
            <>
              <strong>Live workspace.</strong> Only synced records from connected sources appear here.
            </>
          )}
        </span>
      </div>
      {jeff.mode === "live" ? <PushPrompt /> : null}
      {jeff.mode === "live" ? (
        <section className="jobs-strip" aria-label="Jeff's Jobs">
          <JobsStatusLine summary={jobs} />
          <BlindSpotScanButton disabled={jobs?.scannerStatus === "disabled"} />
        </section>
      ) : null}

      {jeff.mode === "live" && focus ? (
        <section className="focus-grid" aria-label="Operating focus">
          <div className="focus-col">
            <div className="section-label">WHAT NEEDS YOUR ATTENTION</div>
            {focus.attention.length ? (
              focus.attention.slice(0, 5).map((a, i) => (
                <Link key={a.id} href="/alerts" className="brief-item">
                  <span className="brief-num">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    <h3>{a.title}</h3>
                    {a.summary ? <p>{a.summary.slice(0, 220)}</p> : null}
                    <span className="brief-actions">
                      <span className="text-button">Investigate</span>
                    </span>
                  </span>
                  <span className={`brief-level ${a.importance === "urgent" ? "urgent" : a.importance === "important" || a.importance === "actionable" ? "high" : ""}`}>
                    {a.importance === "urgent" ? "Urgent" : a.importance === "important" ? "High priority" : a.importance === "actionable" ? "Actionable" : a.importance}
                  </span>
                </Link>
              ))
            ) : (
              <p className="muted focus-empty">Nothing needs your attention right now.</p>
            )}
          </div>
          <div className="focus-col">
            <div className="section-label">GOALS AT RISK</div>
            {goalsAtRisk.length ? (
              goalsAtRisk.slice(0, 4).map((g) => (
                <Link key={g.id} href="/goals" className="focus-row">
                  <span className={`pill ${g.trajectory === "severely_at_risk" ? "danger" : "amber"}`}>{g.label}</span>
                  <span className="focus-copy">
                    <strong>{g.name}</strong>
                    <small>
                      {g.primary ?? ""}
                      {g.constraint ? ` · constraint: ${g.constraint}` : ""}
                      {g.daysRemaining != null ? ` · ${g.daysRemaining}d left` : ""}
                    </small>
                  </span>
                  <Icon name="arrowUpRight" className="arrow-icon" />
                </Link>
              ))
            ) : (
              <p className="muted focus-empty">No active goal is at risk.</p>
            )}
            <div className="section-label">OPPORTUNITIES</div>
            {focus.opportunities.length ? (
              focus.opportunities.slice(0, 4).map((f) => (
                <Link key={f.id} href="/insights" className="focus-row">
                  <span className="pill neutral">{f.category.replace(/_/g, " ")}</span>
                  <span className="focus-copy">
                    <strong>{f.title}</strong>
                  </span>
                  <Icon name="arrowUpRight" className="arrow-icon" />
                </Link>
              ))
            ) : (
              <p className="muted focus-empty">No open findings.</p>
            )}
          </div>
          <div className="focus-col">
            <div className="section-label">TODAY</div>
            {focus.today.length ? (
              focus.today.slice(0, 6).map((t) => (
                <div key={`${t.kind}:${t.id}`} className="focus-row static">
                  <span className={`pill ${t.overdue ? "amber" : "neutral"}`}>{t.kind === "event" ? "event" : t.overdue ? "overdue" : "due"}</span>
                  <span className="focus-copy">
                    <strong>{t.title}</strong>
                    <small>{t.detail}</small>
                  </span>
                </div>
              ))
            ) : (
              <p className="muted focus-empty">Nothing scheduled or due today in synced data.</p>
            )}
            {focus.followThrough ? (
              <>
                <div className="section-label">NEEDS FOLLOW-THROUGH</div>
                {focus.followThrough.unresolved ? (
                  <>
                    <p className="muted focus-empty" style={{ marginBottom: 6 }}>
                      {focus.followThrough.unresolved} unresolved · {focus.followThrough.overdue} overdue · {focus.followThrough.waiting_on_other} waiting on someone else · {focus.followThrough.possibly_complete} possible completion{focus.followThrough.possibly_complete === 1 ? "" : "s"}
                    </p>
                    {focus.followThrough.top.map((o) => (
                      <Link key={o.id} href="/follow-through" className="focus-row">
                        <span className={`pill ${o.bucket === "overdue" ? "amber" : o.bucket === "possibly_complete" ? "info" : "neutral"}`}>{o.bucket === "possibly_complete" ? "confirm" : o.bucket === "waiting_on_other" ? "waiting" : o.bucket === "overdue" ? "overdue" : "open"}</span>
                        <span className="focus-copy">
                          <strong>{o.title}</strong>
                          <small>{o.bucket === "possibly_complete" && o.question ? o.question : o.bucket === "waiting_on_other" ? `Waiting on ${o.waiting_on ?? "someone else"}` : o.due_at ? `Due ${new Date(o.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "No due date"}</small>
                        </span>
                        <Icon name="arrowUpRight" className="arrow-icon" />
                      </Link>
                    ))}
                    <Link className="text-button" href="/follow-through">
                      Review all <Icon name="arrowRight" />
                    </Link>
                  </>
                ) : (
                  <p className="muted focus-empty">Nothing unresolved.</p>
                )}
              </>
            ) : null}
            <div className="section-label">ACTIVE MISSIONS</div>
            {focus.missions.length ? (
              focus.missions.slice(0, 4).map((m) => (
                <Link key={m.id} href="/missions" className="focus-row">
                  <span className="pill info">{m.status}</span>
                  <span className="focus-copy">
                    <strong>
                      {m.code} · {m.title}
                    </strong>
                  </span>
                  <Icon name="arrowUpRight" className="arrow-icon" />
                </Link>
              ))
            ) : (
              <p className="muted focus-empty">No active missions.</p>
            )}
            {focus.freshness.length ? <p className="auth-note">{focus.freshness.join(" · ")}</p> : null}
          </div>
        </section>
      ) : null}

      <section className="command-card" aria-label="Command Jeff">
        <div className="command-card-title">
          <Icon name="sparkles" />
          <strong>What should we accomplish?</strong>
          <span className="command-tag">YOU SET THE DIRECTION</span>
        </div>
        <form onSubmit={submitCommand}>
          <label className="sr-only" htmlFor="missionInput">
            Describe a task for Jeff
          </label>
          <textarea
            id="missionInput"
            rows={2}
            maxLength={2000}
            placeholder="Investigate duplicate leads. Prepare a fix and test it before publishing..."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submitCommand();
              }
            }}
          />
          <div className="command-bottom">
            <div className="mode-switch" aria-label="Task mode">
              {(["prepare", "ask", "run"] as CommandMode[]).map((m) => (
                <button key={m} type="button" className={commandMode === m ? "selected" : ""} aria-pressed={commandMode === m} onClick={() => setCommandMode(m)}>
                  {m === "prepare" ? "Prepare" : m === "ask" ? "Ask" : "Run approved"}
                </button>
              ))}
            </div>
            <button className="button primary" type="submit" disabled={submitting}>
              <Icon name="arrowUp" />
              <span>{commandMode === "prepare" ? "Create draft" : commandMode === "ask" ? "Ask Jeff" : "Check availability"}</span>
            </button>
          </div>
        </form>
      </section>

      <div className="mission-pulse">
        <Link href="/missions">
          <Icon name="compose" />
          <strong>{jeff.missionCount}</strong> missions
        </Link>
        <Link href="/approvals">
          <span className="review-dot small" />
          <strong>{jeff.approvalCount}</strong> needs review
        </Link>
        <Link href="/security">
          <Icon name="lock" />
          Access &amp; secret policy
        </Link>
      </div>

      <section className="stats-row" aria-label="Knowledge statistics">
        <div className="stat">
          <div className="stat-label">
            <Icon name="layers" />
            Memories
          </div>
          <div className="stat-value">
            <span>{all.length.toLocaleString()}</span>
            <small>ready to recall</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">
            <Icon name="link" />
            Connections
          </div>
          <div className="stat-value">
            <span>{linksFor(all).length.toLocaleString()}</span>
            <small>shared context</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">
            <Icon name="plug" />
            Sources
          </div>
          <div className="stat-value">
            <span>{ids.length}</span>
            <small>
              <span className="health-dot" />
              <span>{jeff.mode === "demo" ? "in your orbit" : "connected"}</span>
            </small>
          </div>
        </div>
      </section>

      {goalsAtRisk.length && !(jeff.mode === "live" && focus) ? (
        <section className="signal-strip goals-risk-strip" aria-label="Goals at risk">
          <div>
            <span className="mini-eyebrow">GOALS AT RISK</span>
            <h3>{goalsAtRisk.length === 1 ? goalsAtRisk[0]!.name : `${goalsAtRisk.length} goals need attention`}</h3>
            <p>
              {goalsAtRisk
                .slice(0, 2)
                .map((g) => `${g.name}: ${g.label}${g.primary ? ` · ${g.primary}` : ""}${g.constraint ? ` · constraint: ${g.constraint}` : ""}`)
                .join("  |  ")}
            </p>
          </div>
          <Link className="button secondary" href="/goals">
            Open goals
            <Icon name="arrowUpRight" />
          </Link>
        </section>
      ) : null}

      <section className={`brain-card ${expanded ? "expanded" : ""}`} id="brainCard" aria-label="Interactive knowledge network">
        <div className="graph-topbar">
          <div>
            <span className="graph-title">
              <Icon name="network" />
              Jeff&apos;s neural network
            </span>
            <span className="graph-description">
              {ids.length} {jeff.mode === "demo" ? "sample" : "connected"} sources. One connected workspace.
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={expanded ? "Collapse brain visualization" : "Expand brain visualization"}
            onClick={() => {
              setExpanded((v) => !v);
              setTimeout(() => brain.current?.resize(), 20);
            }}
          >
            <Icon name="expand" />
          </button>
        </div>
        <div className="brain-stage" id="brainStage">
          <BrainCanvas
            ref={brain}
            docs={all}
            connected={ids}
            focus={focused}
            motion={jeff.motion}
            anchors={anchors}
            active
            onOpen={(id) => {
              const d = all.find((x) => x.id === id);
              if (d) jeff.openModal(<DocModal doc={d} />);
            }}
            onZoom={setZoom}
            onHover={setHover}
          />
          <div id="graphAnchors">
            {anchors.map((a) => {
              const s = sourceDef(a.id);
              const count = all.filter((d) => d.source === a.id).length;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`graph-anchor ${focused === a.id ? "highlighted" : focused ? "dimmed" : ""}`}
                  style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, ["--source-color" as string]: s.color, display: jeff.labels ? undefined : "none" }}
                  aria-label={`Explore ${s.name}; ${count} memories`}
                  onClick={() => jeff.setFocusSource(focused === a.id ? null : a.id)}
                >
                  <SourceIcon id={a.id} />
                  <span>{s.name}</span>
                  <small>{count}</small>
                </button>
              );
            })}
          </div>
          <div className="brain-caption">
            <span className="caption-line" />
            THE BIGGER PICTURE
            <span className="caption-line" />
          </div>
          <div className="node-tooltip" hidden={!hover} style={hover ? { left: Math.max(8, hover.x + 10), top: Math.max(0, hover.y - 30) } : undefined}>
            {hover?.title}
          </div>
        </div>
        <div className="graph-bottom">
          <div className="graph-legend">
            <span className="health-dot" />
            <span>{focused ? `${sourceDef(focused).name} / ${visible.length} memories` : `${ids.length} sources, one connected mind`}</span>
          </div>
          <div className="graph-controls">
            <button className="icon-button" type="button" aria-label="Zoom out" onClick={() => brain.current?.setZoom((brain.current?.getZoom() ?? 1) - 0.1)}>
              <Icon name="minus" />
            </button>
            <button className="zoom-label" type="button" aria-label="Reset graph view" onClick={() => brain.current?.reset()}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-button" type="button" aria-label="Zoom in" onClick={() => brain.current?.setZoom((brain.current?.getZoom() ?? 1) + 0.1)}>
              <Icon name="plus" />
            </button>
            <span className="control-divider" />
            <button className="icon-button" type="button" aria-label={jeff.motion ? "Pause animation" : "Play animation"} onClick={() => jeff.setMotion(!jeff.motion)}>
              <Icon name={jeff.motion ? "pause" : "play"} />
            </button>
          </div>
        </div>
      </section>

      {topInsight ? (
        <section className="signal-strip">
          <div>
            <span className="mini-eyebrow">{jeff.mode === "demo" ? "EXAMPLE OPPORTUNITY" : "TOP FINDING"}</span>
            <h3>{topInsight.title}</h3>
            <p>{topInsight.body}</p>
          </div>
          <Link className="button secondary" href="/insights">
            Review
            <Icon name="arrowUpRight" />
          </Link>
        </section>
      ) : null}

      <section className="recent-section">
        <div className="section-heading">
          <h2>
            Fresh in your mind <span>{focused ? sourceDef(focused).name : "RECENT MEMORIES"}</span>
          </h2>
          <Link className="text-button" href={`/memories${focused ? `?source=${focused}` : ""}`}>
            View all
            <Icon name="arrowRight" />
          </Link>
        </div>
        <div className="recent-list">
          {visible.length ? (
            visible.slice(0, 4).map((d) => <MemoryRow key={d.id} d={d} />)
          ) : (
            <EmptyState title="A little space for your next idea.">Connect a source or add a note to get started.</EmptyState>
          )}
        </div>
      </section>
      <div className="bottom-note">
        <Icon name="lock" />
        <span>{jeff.mode === "demo" ? "Sample data only. No live source is connected in demo mode." : "Live workspace. Credentials stay encrypted server-side; Jeff only sees narrow tool results."}</span>
      </div>
    </div>
  );
}
