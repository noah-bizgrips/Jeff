"use client";

import { useMemo, useRef, useState } from "react";
import { useJeff } from "@/components/jeff/store";
import { SourceIcon } from "@/components/jeff/icons";
import { BrainCanvas, type BrainHandle } from "./BrainCanvas";
import { WhatJeffSeesModal } from "./WhatJeffSees";
import { SEED_DOCS } from "@/lib/jeff/demo-data";
import { sourceDef } from "@/lib/jeff/sources";
import { computeBrainState, liteOf } from "@/lib/jeff/brain/state";
import { sourcesForProvider } from "@/lib/jeff/brain/sources";
import { SCENARIOS, alert } from "@/lib/jeff/brain/fixtures";
import { BRAIN_POLICY } from "@/lib/jeff/brain/policy";

/**
 * Dev harness: every brain state on demand, computed by the real aggregator
 * from canned inputs. Not linked from navigation; the page 404s in production
 * unless JEFF_BRAIN_LAB=1.
 */
export function BrainLab() {
  const jeff = useJeff();
  const brain = useRef<BrainHandle>(null);
  const [scenarioId, setScenarioId] = useState(SCENARIOS[2]!.id);
  const [extraReasons, setExtraReasons] = useState(0);
  const [motion, setMotion] = useState(true);
  const [hover, setHover] = useState<{ title: string; x: number; y: number } | null>(null);
  const [narrow, setNarrow] = useState(false);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;
  const state = useMemo(() => {
    const input = { ...scenario.input, alerts: [...scenario.input.alerts] };
    for (let i = 0; i < extraReasons; i++) input.alerts.push(alert(`new-${i}`, "important", `New: client ${i + 1} went quiet`, { category: "quiet_client", evidence: [{ provider: "portal" }] }));
    return computeBrainState(input);
  }, [scenario, extraReasons]);
  const lite = useMemo(() => liteOf(state), [state]);
  const activity: { kind: "ask" | "scan" | "job" | null; sources: string[] } = scenario.activity ?? { kind: null, sources: [] };

  const ids = useMemo(() => [...new Set(scenario.input.connections.flatMap((c) => sourcesForProvider(c.provider, c.capabilities)))], [scenario]);
  const docs = useMemo(() => SEED_DOCS.filter((d) => ids.includes(d.source)), [ids]);
  const anchors = useMemo(() => ids.map((id, i) => ({ id, x: 0.5 + Math.cos(-Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, ids.length)) * 0.36, y: 0.47 + Math.sin(-Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, ids.length)) * 0.38 })), [ids]);

  const open = () => jeff.openModal(<WhatJeffSeesModal brain={state} />);

  return (
    <section className="page-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">DEV HARNESS</span>
          <h1>Brain lab</h1>
          <p className="muted">Every state the brain can show, computed by the real aggregator from canned inputs. Not in navigation.</p>
        </div>
      </div>

      <div className="connection-actions" style={{ flexWrap: "wrap", marginBottom: 14 }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`button ${s.id === scenarioId ? "primary" : "secondary"}`}
            onClick={() => {
              setScenarioId(s.id);
              setExtraReasons(0);
            }}
          >
            {s.title}
          </button>
        ))}
      </div>
      <div className="connection-actions" style={{ flexWrap: "wrap", marginBottom: 14 }}>
        <button type="button" className="button secondary" onClick={() => setExtraReasons((n) => n + 1)}>
          Add a new reason (one-time pulse)
        </button>
        <button type="button" className="button secondary" onClick={() => setMotion((m) => !m)}>
          {motion ? "Simulate reduced motion" : "Restore motion"}
        </button>
        <button type="button" className="button secondary" onClick={() => setNarrow((n) => !n)}>
          {narrow ? "Desktop width" : "Phone width (400px)"}
        </button>
        <button type="button" className="button secondary" onClick={open}>
          Open “What Jeff sees”
        </button>
      </div>

      <section className="brain-card" style={{ maxWidth: narrow ? 400 : undefined }} aria-label="Brain lab stage">
        <div className="graph-topbar">
          <div>
            <span className="graph-title">{scenario.title}</span>
            <span className="graph-description">{scenario.spec}</span>
          </div>
        </div>
        <div className="brain-stage" data-brain-state={state.state} data-brain-urgency={state.urgency}>
          <BrainCanvas ref={brain} docs={docs} connected={ids} focus={null} motion={motion} anchors={anchors} active brain={lite} activity={activity} onOpen={() => undefined} onCenter={open} onZoom={() => undefined} onHover={setHover} />
          <button type="button" className="brain-center-button" aria-label={`What Jeff sees: ${state.primaryStatus}`} onClick={open} />
          <div id="graphAnchors">
            {anchors.map((a) => {
              const s = sourceDef(a.id);
              const affected = state.affectedSources.find((x) => x.source === a.id);
              return (
                <button key={a.id} type="button" className="graph-anchor" style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, ["--source-color" as string]: s.color }} data-tone={affected?.tone ?? (activity.sources.includes(a.id) ? "active" : undefined)} title={affected ? `${s.name} · ${affected.label}` : s.name}>
                  <SourceIcon id={a.id} />
                  <span>{s.name}</span>
                </button>
              );
            })}
          </div>
          <div className="node-tooltip" hidden={!hover} style={hover ? { left: Math.max(8, hover.x + 10), top: Math.max(0, hover.y - 30) } : undefined}>
            {hover?.title}
          </div>
        </div>
        <div className="graph-bottom">
          <div className="graph-legend">
            <span className="health-dot" data-tone={state.state === "attention" ? (state.urgency === "urgent" ? "danger" : "warning") : state.state === "opportunity" ? "opportunity" : state.state === "degraded" ? "warning" : activity.kind ? "active" : undefined} />
            <button type="button" className="brain-status" onClick={open}>
              <span className="brain-status-primary">{activity.kind ? (activity.kind === "ask" ? "Investigating…" : "Scanning…") : state.primaryStatus}</span>
              <span className="brain-status-secondary">{activity.kind ? `Reading ${activity.sources.length} sources` : state.secondaryStatus}</span>
            </button>
          </div>
          <div className="graph-legend">
            <span>
              pulse {Math.round(activity.kind ? BRAIN_POLICY.pulseMs.investigating! : state.state === "attention" ? (state.urgency === "urgent" ? BRAIN_POLICY.pulseMs.urgent! : BRAIN_POLICY.pulseMs.attention!) : state.state === "opportunity" ? BRAIN_POLICY.pulseMs.opportunity! : state.state === "degraded" ? BRAIN_POLICY.pulseMs.degraded! : ids.length ? BRAIN_POLICY.pulseMs.watching! : BRAIN_POLICY.pulseMs.quiet!)}ms
            </span>
          </div>
        </div>
      </section>

      <details style={{ marginTop: 16 }}>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 11 }}>
          Computed state (JSON)
        </summary>
        <pre style={{ fontSize: 10, overflowX: "auto" }}>{JSON.stringify(state, null, 2)}</pre>
      </details>
    </section>
  );
}
