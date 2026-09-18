"use client";

import Link from "next/link";
import { Icon, SourceIcon } from "@/components/gomez/icons";
import { ModalHeader } from "@/components/gomez/shared";
import { useGomez } from "@/components/gomez/store";
import { sourceDef } from "@/lib/gomez/sources";
import { attentionCountOf, isDueFollowThrough, type BrainReason, type BrainState } from "@/lib/gomez/brain/state";

/** Human label for the ambient state (spec §12). */
export function stateLabel(b: BrainState): string {
  switch (b.state) {
    case "investigating":
      return "Investigating";
    case "attention":
      return b.urgency === "urgent" ? "Urgent attention" : "Needs attention";
    case "opportunity":
      return "Opportunity";
    case "degraded":
      return "Limited visibility";
    default:
      return "Watching";
  }
}

function toneClass(tone: BrainReason["tone"]): string {
  if (tone === "danger") return "danger";
  if (tone === "warning" || tone === "stale") return "amber";
  if (tone === "opportunity") return "info";
  return "neutral";
}

function ReasonRow({ r, onNavigate }: { r: BrainReason; onNavigate: () => void }) {
  return (
    <Link href={r.href} className="focus-row" onClick={onNavigate}>
      <span className={`pill ${toneClass(r.tone)}`}>{r.kind === "connection" ? "source" : r.kind}</span>
      <span className="focus-copy">
        <strong>{r.title}</strong>
        {r.detail ? <small>{r.detail}</small> : null}
      </span>
      {r.sources.length ? (
        <span className="brain-reason-sources" aria-label={`Sources: ${r.sources.map((s) => sourceDef(s).name).join(", ")}`}>
          {r.sources.slice(0, 3).map((s) => (
            <SourceIcon key={s} id={s} />
          ))}
        </span>
      ) : null}
      <Icon name="arrowUpRight" className="arrow-icon" />
    </Link>
  );
}

/**
 * "What Gomez sees": the explanation behind the brain's current state. Every
 * item listed here is exactly what the status counts (spec §15, §21).
 */
export function WhatGomezSeesModal({ brain, onScan }: { brain: BrainState; onScan?: () => void }) {
  const gomez = useGomez();
  const close = () => gomez.closeModal();
  const { attention, opportunities, followThrough, system } = brain.reasons;
  const attentionCount = attentionCountOf(brain.reasons);
  const dueFollowThrough = followThrough.filter(isDueFollowThrough);
  const otherFollowThrough = followThrough.filter((r) => !isDueFollowThrough(r));
  return (
    <>
      <ModalHeader title={brain.primaryStatus} desc={brain.secondaryStatus ?? undefined} eyebrow="WHAT GOMEZ SEES" />
      <div className="modal-body brain-sees">
        <div className="section-label">CURRENT STATE</div>
        <div className="brain-sees-state">
          <span className={`pill ${brain.state === "attention" ? (brain.urgency === "urgent" ? "danger" : "amber") : brain.state === "opportunity" ? "info" : brain.state === "degraded" ? "amber" : "neutral"}`}>{stateLabel(brain)}</span>
          <span className="muted">
            Attention {Math.round(brain.attentionLevel * 100)}% · Opportunity {Math.round(brain.opportunityLevel * 100)}% · System health {Math.round(brain.systemHealth * 100)}%
          </span>
        </div>

        <div className="section-label">NEEDS ATTENTION ({attentionCount})</div>
        {attention.length || dueFollowThrough.length ? (
          [...attention, ...dueFollowThrough].map((r) => <ReasonRow key={r.id} r={r} onNavigate={close} />)
        ) : (
          <p className="muted focus-empty">Nothing needs your attention right now.</p>
        )}

        <div className="section-label">FOLLOW-THROUGH</div>
        {otherFollowThrough.length ? otherFollowThrough.map((r) => <ReasonRow key={r.id} r={r} onNavigate={close} />) : <p className="muted focus-empty">{dueFollowThrough.length ? "Everything else is on track." : "No overdue or waiting commitments weighed in."}</p>}

        <div className="section-label">OPPORTUNITIES ({opportunities.length})</div>
        {opportunities.length ? opportunities.map((r) => <ReasonRow key={r.id} r={r} onNavigate={close} />) : <p className="muted focus-empty">No opportunities surfaced yet.</p>}

        <div className="section-label">SYSTEM HEALTH</div>
        {system.length ? system.map((r) => <ReasonRow key={r.id} r={r} onNavigate={close} />) : <p className="muted focus-empty">All connected sources are fresh and jobs are healthy.</p>}

        <div className="modal-actions brain-sees-actions">
          <Link className="button secondary" href="/alerts" onClick={close}>
            View all alerts
          </Link>
          <Link className="button secondary" href="/follow-through" onClick={close}>
            Review Follow-Through
          </Link>
          <Link className="button secondary" href="/insights" onClick={close}>
            View opportunities
          </Link>
          <Link className="button secondary" href="/connections" onClick={close}>
            System health
          </Link>
          {onScan ? (
            <button
              className="button primary"
              type="button"
              onClick={() => {
                close();
                onScan();
              }}
            >
              <span aria-hidden="true">✦</span> Find what I&apos;m missing
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
