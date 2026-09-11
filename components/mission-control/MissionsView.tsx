"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, SourceIcon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { EmptyState, ModalHeader } from "@/components/jeff/shared";

export interface MissionItem {
  id: string;
  code: string;
  title: string;
  goal: string;
  status: string;
  worker: string;
  environment: string;
  budgetUsd: number;
  timeLimitMin: number;
  maxRetries: number;
  createdAt: string;
  isSample: boolean;
  result?: Record<string, unknown>;
}

export interface ApprovalItem {
  id: string;
  action: string;
  artifactRef: string | null;
  environment: string;
  status: string;
  requestedAt: string;
  expiresAt: string | null;
  reason: string | null;
  mission: { code: string; title: string; goal: string } | null;
}

const STATUS_LABEL: Record<string, [string, string]> = {
  draft: ["Draft", "neutral"],
  queued: ["Queued", "info"],
  running: ["Running", "info"],
  review: ["Needs review", "amber"],
  blocked: ["Worker not connected", "neutral"],
  approved: ["Approved", "ok"],
  rejected: ["Rejected", "danger"],
  completed: ["Completed", "ok"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
};

function statusPill(s: string) {
  const [label, tone] = STATUS_LABEL[s] ?? [s, "neutral"];
  return <span className={`pill ${tone}`}>{label}</span>;
}

function workerIcon(worker: string) {
  return worker === "n8n" ? "n8n" : worker === "claude" ? "claude" : "github";
}

export function MissionCard({ m, onOpen }: { m: MissionItem; onOpen: (m: MissionItem) => void }) {
  return (
    <article className="mission-card">
      <div className="mission-card-top">
        <span className="mission-code">
          {m.code} / {m.isSample ? "ILLUSTRATIVE" : m.environment.toUpperCase()}
        </span>
        {statusPill(m.status)}
      </div>
      <h3>{m.title}</h3>
      <p>{m.goal}</p>
      <div className="mission-card-footer">
        <SourceIcon id={workerIcon(m.worker)} />
        <span>{m.worker}</span>
        <span className="permission-tag">{m.environment === "production" ? "Production (approval-gated)" : "No production access"}</span>
        <span>${m.budgetUsd} cap</span>
        <button className="button secondary" type="button" onClick={() => onOpen(m)}>
          {m.status === "review" ? "Review" : "View task"} <Icon name="arrowUpRight" />
        </button>
      </div>
    </article>
  );
}

function MissionModal({ m, onChange }: { m: MissionItem; onChange: (id: string, status: string) => Promise<void> }) {
  const { closeModal, mode } = useJeff();
  const [busy, setBusy] = useState(false);
  async function set(status: string) {
    setBusy(true);
    await onChange(m.id, status);
    setBusy(false);
    closeModal();
  }
  return (
    <>
      <ModalHeader title={m.title} desc="A reviewable plan, not a claim that work has been performed." eyebrow={`${m.code} / ${m.isSample ? "EXAMPLE" : m.status.toUpperCase()}`} />
      <div className="modal-body">
        <div className="callout">
          <strong>{m.status === "review" ? "Change review." : "Task draft."}</strong>{" "}
          {mode === "demo" || m.isSample ? "Sample mission: no code, workflow, or upstream change exists." : "Workers run only in an isolated sandbox. Production effects require an approval bound to the exact artifact version."}
        </div>
        <div className="detail-content">{m.goal}</div>
        <div className="task-detail-grid">
          <div className="detail-box">
            <small>Worker</small>
            <strong>{m.worker === "claude" ? "Claude technical worker" : m.worker}</strong>
          </div>
          <div className="detail-box">
            <small>Allowed environment</small>
            <strong>{m.environment === "sandbox" ? "Isolated sandbox only" : "Production (approval required)"}</strong>
          </div>
          <div className="detail-box">
            <small>Limits</small>
            <strong>
              ${m.budgetUsd} / {m.timeLimitMin} minutes / {m.maxRetries} retries
            </strong>
          </div>
          <div className="detail-box">
            <small>Release policy</small>
            <strong>Explicit approval of exact version</strong>
          </div>
        </div>
        <div className="section-label">ACCEPTANCE CRITERIA</div>
        <ul className="checklist">
          <li>
            <Icon name="check" />
            Use synthetic records; never contact real customers during tests.
          </li>
          <li>
            <Icon name="check" />
            Attach evidence, a change summary, and actual test results.
          </li>
          <li>
            <Icon name="check" />
            Keep credentials in the server-side broker, outside agent context.
          </li>
          <li>
            <Icon name="check" />
            Stop before merge, publish, deploy, or other production effects.
          </li>
        </ul>
        {m.result && Object.keys(m.result).length ? (
          <>
            <div className="section-label">RESULT / EVIDENCE</div>
            <div className="diff-preview">{JSON.stringify(m.result, null, 2)}</div>
          </>
        ) : null}
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={closeModal}>
            Close
          </button>
          {!m.isSample && !["cancelled", "completed"].includes(m.status) ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => set("cancelled")}>
              Cancel mission
            </button>
          ) : null}
          {!m.isSample && m.status === "draft" ? (
            <button className="button primary" type="button" disabled={busy} onClick={() => set("queued")}>
              Queue for sandbox worker
            </button>
          ) : null}
          {m.isSample ? (
            <Link className="button primary" href="/connections" onClick={closeModal}>
              Worker setup <Icon name="arrowUpRight" />
            </Link>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function MissionsView({ initial }: { initial: MissionItem[] }) {
  const jeff = useJeff();
  const [missions, setMissions] = useState(initial);
  const [filter, setFilter] = useState("all");
  const list = missions.filter((m) => filter === "all" || m.status === filter);

  async function change(id: string, status: string) {
    const target = missions.find((m) => m.id === id);
    if (!target || target.isSample) return;
    const res = await fetch(`/api/missions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (!res.ok) return jeff.toast("Could not update the mission.");
    setMissions((ms) => ms.map((m) => (m.id === id ? { ...m, status } : m)));
    jeff.toast(status === "queued" ? "Queued. The sandbox worker is not enabled yet; nothing will run until it is." : "Mission updated.");
  }

  return (
    <section className="page-view" id="missionsView">
      <div className="preview-banner">
        <Icon name="info" />
        <span>
          {jeff.mode === "demo" ? (
            <>
              Sample missions. <strong>No worker, queue, or live execution is connected in demo mode.</strong>
            </>
          ) : (
            <>
              Missions are drafts until approved. <strong>The sandbox worker runs only approved, sandbox-scoped tasks.</strong>
            </>
          )}
        </span>
      </div>
      <div className="view-toolbar">
        <div className="filter-tabs" style={{ margin: 0 }}>
          {[
            ["all", "All missions"],
            ["draft", "Drafts"],
            ["review", "Needs review"],
            ["approved", "Approved"],
            ["completed", "Completed"],
          ].map(([id, label]) => (
            <button key={id} type="button" className={`filter-tab ${filter === id ? "active" : ""}`} onClick={() => setFilter(id!)}>
              {label}
            </button>
          ))}
        </div>
        <Link className="button primary" href="/">
          <Icon name="plus" />
          New mission
        </Link>
      </div>
      <div className="mission-list">
        {list.length ? (
          list.map((m) => <MissionCard key={m.id} m={m} onOpen={(mm) => jeff.openModal(<MissionModal m={mm} onChange={change} />)} />)
        ) : (
          <EmptyState title="Nothing in this lane.">Create a task draft from Mission control or choose another filter.</EmptyState>
        )}
      </div>
    </section>
  );
}

export function ApprovalsView({ initial, reviewMissions }: { initial: ApprovalItem[]; reviewMissions: MissionItem[] }) {
  const jeff = useJeff();
  const [approvals, setApprovals] = useState(initial);
  const pending = approvals.filter((a) => a.status === "pending");

  async function decide(a: ApprovalItem, decision: "granted" | "denied") {
    const res = await fetch(`/api/approvals/${a.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, artifactRef: a.artifactRef ?? undefined }),
    });
    if (!res.ok) return jeff.toast("Could not record the decision.");
    setApprovals((list) => list.map((x) => (x.id === a.id ? { ...x, status: decision } : x)));
    jeff.closeModal();
    jeff.toast(decision === "granted" ? "Approval granted for this exact version. Valid for 60 minutes." : "Approval denied.");
  }

  function open(a: ApprovalItem) {
    jeff.openModal(<ApprovalModal a={a} onDecide={decide} />);
  }

  return (
    <section className="page-view" id="approvalsView">
      <div className="preview-banner">
        <Icon name="lock" />
        <span>
          <strong>Every approval binds to an exact artifact, action, environment and expiry</strong> and is recorded with your verified MFA session.
        </span>
      </div>
      <div className="view-toolbar">
        <p>A production approval must bind to the exact artifact version, permitted action, environment, expiry, and a fresh authenticated session.</p>
        <span className={`pill ${pending.length ? "amber" : ""}`}>
          {pending.length} pending
        </span>
      </div>
      <div className="mission-list">
        {pending.map((a) => (
          <article className="mission-card" key={a.id}>
            <div className="mission-card-top">
              <span className="mission-code">
                {a.mission?.code ?? "APPROVAL"} / {a.environment.toUpperCase()}
              </span>
              <span className="pill amber">Pending</span>
            </div>
            <h3>{a.mission?.title ?? a.action}</h3>
            <p>
              Action: <strong>{a.action}</strong>
              {a.artifactRef ? ` · Artifact: ${a.artifactRef}` : ""}
            </p>
            <div className="mission-card-footer">
              <button className="button secondary" type="button" onClick={() => open(a)}>
                Review <Icon name="arrowUpRight" />
              </button>
            </div>
          </article>
        ))}
        {reviewMissions.map((m) => (
          <MissionCard key={m.id} m={m} onOpen={(mm) => jeff.openModal(<MissionModal m={mm} onChange={async () => {}} />)} />
        ))}
        {!pending.length && !reviewMissions.length ? <EmptyState title="Your review queue is clear.">No production change is waiting on you.</EmptyState> : null}
      </div>
    </section>
  );
}

function ApprovalModal({ a, onDecide }: { a: ApprovalItem; onDecide: (a: ApprovalItem, d: "granted" | "denied") => Promise<void> }) {
  const { closeModal } = useJeff();
  const [checked, setChecked] = useState(false);
  return (
    <>
      <ModalHeader title={a.mission?.title ?? a.action} desc="Approve only the exact version described here." eyebrow={`${a.mission?.code ?? "APPROVAL"} / ${a.environment.toUpperCase()}`} />
      <div className="modal-body">
        <dl className="kv">
          <dt>Action</dt>
          <dd>{a.action}</dd>
          <dt>Artifact</dt>
          <dd>{a.artifactRef ?? "—"}</dd>
          <dt>Environment</dt>
          <dd>{a.environment}</dd>
          <dt>Requested</dt>
          <dd>{new Date(a.requestedAt).toLocaleString()}</dd>
        </dl>
        {a.mission ? <div className="detail-content">{a.mission.goal}</div> : null}
        <label className="approval-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I reviewed the exact artifact and authorize this action in this environment.</span>
        </label>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={closeModal}>
            Close
          </button>
          <button className="button secondary" type="button" onClick={() => onDecide(a, "denied")}>
            Deny
          </button>
          <button className="button primary" type="button" disabled={!checked} onClick={() => onDecide(a, "granted")}>
            Approve exact version
          </button>
        </div>
      </div>
    </>
  );
}
