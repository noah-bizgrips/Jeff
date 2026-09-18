"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, SourceIcon } from "./icons";
import { useGomez } from "./store";
import { ModalHost, Toasts, AddNoteModal } from "./shared";
import { AgentPanel } from "@/components/assistant/AgentPanel";
import { sourceDef } from "@/lib/gomez/sources";

const NAV: { href: string; icon: string; label: string; end?: "home" | "missions" | "approvals" | "key" | "memories" | "saved" | "alerts" }[] = [
  { href: "/", icon: "network", label: "Mission control", end: "home" },
  { href: "/alerts", icon: "bell", label: "Alerts", end: "alerts" },
  { href: "/briefings", icon: "inbox", label: "Briefings" },
  { href: "/goals", icon: "target", label: "Goals" },
  { href: "/jobs", icon: "briefcase", label: "Gomez's Jobs" },
  { href: "/follow-through", icon: "refresh", label: "Follow-Through" },
  { href: "/missions", icon: "compose", label: "Missions", end: "missions" },
  { href: "/insights", icon: "sun", label: "Operations & insights" },
  { href: "/approvals", icon: "check", label: "Approvals", end: "approvals" },
  { href: "/search", icon: "search", label: "Search everything", end: "key" },
  { href: "/memories", icon: "layers", label: "Memories", end: "memories" },
  { href: "/saved", icon: "bookmark", label: "Saved answers", end: "saved" },
  { href: "/connections", icon: "plug", label: "Connections" },
  { href: "/memory", icon: "brain", label: "Memory & rules" },
  { href: "/settings", icon: "sliders", label: "Settings" },
  { href: "/guide", icon: "info", label: "How to use Gomez" },
  { href: "/security", icon: "lock", label: "Security & access" },
];

const TITLES: Record<string, [string, string, string]> = {
  "/": ["Your business. In focus", "Connect your knowledge. Turn the next right idea into action.", "Mission control"],
  "/alerts": ["What deserves attention", "Only what matters, when it matters. Quiet by default.", "Alerts"],
  "/follow-through": ["What still needs to happen", "Resolved when the thing is actually done — not when a reminder was shown.", "Follow-Through"],
  "/briefings": ["Your briefings", "Daily brief, weekly operating review, monthly owner review.", "Briefings"],
  "/settings": ["How Gomez should behave", "Briefing times, quiet hours, notification thresholds, learning.", "Settings"],
  "/guide": ["How to use Gomez", "Every area explained, and the habits that make Gomez useful.", "Guide"],
  "/goals": ["What you're aiming for", "Outcomes, the metrics behind them, and whether you're on pace.", "Goals"],
  "/jobs": ["Gomez's Jobs", "Recurring analysts that watch your business between conversations. Test before you trust.", "Gomez's Jobs"],
  "/missions": ["From intent to action", "Draft, review, and track work. No hidden production changes.", "Missions"],
  "/insights": ["Find the next improvement", "Evidence first. A specific action next. Outcomes after.", "Operations & insights"],
  "/approvals": ["The important decisions are yours", "Review the exact change before anything leaves the sandbox.", "Approvals"],
  "/connections": ["Bring your tools together", "Knowledge sources and execution tools, with separate permissions.", "Connections"],
  "/security": ["Private by design", "Your identity. Your boundaries. No pretend security badges.", "Security & access"],
  "/memory": ["What Gomez knows about you", "Preferences, definitions and rules — learned from you, editable by you.", "Memory & rules"],
  "/search": ["A little less searching", "Find the right thought, no matter where it lives.", "Search everything"],
  "/memories": ["Everything you remember", "Your messages, documents, and ideas. All connected.", "Memories"],
  "/saved": ["Worth coming back to", "The answers and insights you chose to keep.", "Saved answers"],
};

export function AppShell({ children }: { children: ReactNode }) {
  const gomez = useGomez();
  const pathname = usePathname();
  const base = "/" + (pathname.split("/")[1] ?? "");
  const title = TITLES[base] ?? TITLES["/"]!;
  const ids = gomez.connectedSources();
  const docCount = gomez.docs().length;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        gomez.closeModal();
        gomez.navigate("/search");
      }
      if (e.key === "Escape") {
        gomez.setAgentOpen(false);
        gomez.setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [gomez]);

  return (
    <div className="app">
      <aside className={`sidebar ${gomez.sidebarOpen ? "open" : ""}`} id="sidebar">
        <Link className="brand" href="/" aria-label="Gomez home">
          <span className="brand-symbol">
            <Icon name="brain" />
          </span>
          <span>
            Gomez<span className="brand-period">.</span>
          </span>
        </Link>
        <Link className="workspace-switch" href="/security">
          <span className="workspace-avatar">N</span>
          <span>
            <strong>My workspace</strong>
            <small>Gomez / Second brain</small>
          </span>
          <Icon name="chevrons" className="muted" />
        </Link>
        <div className="nav-label">COMMAND CENTER</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`nav-item ${base === n.href ? "active" : ""}`} onClick={() => gomez.setSidebarOpen(false)}>
              <Icon name={n.icon} />
              {n.label}
              {n.end === "home" ? <span className="nav-end small-pill">Home</span> : null}
              {n.end === "missions" ? <span className="nav-end nav-count">{gomez.missionCount}</span> : null}
              {n.end === "approvals" && gomez.approvalCount > 0 ? <span className="nav-end review-dot">{gomez.approvalCount}</span> : null}
              {n.end === "key" ? <span className="nav-end keycap">K</span> : null}
              {n.end === "memories" ? <span className="nav-end nav-count">{docCount}</span> : null}
              {n.end === "saved" ? <span className="nav-end nav-count">{gomez.saved.length}</span> : null}
              {n.end === "alerts" && gomez.alertCount > 0 ? <span className="nav-end review-dot">{gomez.alertCount}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="nav-label source-label">
          {gomez.mode === "demo" ? "SAMPLE SOURCES" : "CONNECTED SOURCES"}
          <Link className="tiny-button" aria-label="Manage sources" href="/connections">
            <Icon name="plus" />
          </Link>
        </div>
        <div className="source-list">
          {ids.length ? (
            ids.map((id) => (
              <button
                key={id}
                type="button"
                className={`source-item ${gomez.focusSource === id ? "selected" : ""}`}
                title={`Explore ${sourceDef(id).name} memories`}
                onClick={() => {
                  gomez.setFocusSource(gomez.focusSource === id ? null : id);
                  if (base !== "/") gomez.navigate("/");
                }}
              >
                <SourceIcon id={id} />
                <span>{sourceDef(id).name}</span>
                <span className="status-dot" />
              </button>
            ))
          ) : (
            <div style={{ padding: 10, fontSize: 10, color: "#7d93b1" }}>Your next connection starts here.</div>
          )}
        </div>
        <Link className="connect-more" href="/connections">
          <Icon name="plus" />
          Connect a source
        </Link>
        <div className="nav-label spaces-label">COLLECTIONS</div>
        <Link className="nav-item" href="/memories?collection=projects">
          <span className="collection-dot" style={{ ["--dot" as string]: "#96b5e0" }} />
          Projects
        </Link>
        <Link className="nav-item" href="/memories?collection=people">
          <span className="collection-dot" style={{ ["--dot" as string]: "#97a9c1" }} />
          People &amp; clients
        </Link>
        <Link className="nav-item" href="/memories?collection=ideas">
          <span className="collection-dot" style={{ ["--dot" as string]: "#9cadc4" }} />
          Ideas &amp; inspiration
        </Link>
        <div className="sidebar-bottom">
          <div className="workspace-health">
            <span className="health-dot" />
            <span>{gomez.mode === "demo" ? "Sample workspace / no live access" : `${ids.length} sources in your live workspace`}</span>
          </div>
          <div className="sidebar-divider" />
          <Link className="profile" href="/security">
            <span className="profile-avatar">N</span>
            <span>
              <strong>Noah / BizGrips</strong>
              <small>Security &amp; access</small>
            </span>
            <Icon name="settings" />
          </Link>
        </div>
      </aside>

      {/* Tap-to-close scrim for the phone sidebar drawer. */}
      <button
        type="button"
        className="drawer-scrim"
        aria-label="Close navigation"
        hidden={!gomez.sidebarOpen}
        onClick={() => gomez.setSidebarOpen(false)}
      />
      <div className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" aria-label="Toggle navigation" onClick={() => gomez.setSidebarOpen(!gomez.sidebarOpen)}>
            <Icon name="menu" />
          </button>
          <div className="breadcrumb">
            <Icon name="grid" />
            <span>Workspace</span>
            <span className="crumb-divider">/</span>
            <strong>{title[2]}</strong>
          </div>
          <Link className="global-search" href="/search">
            <Icon name="search" />
            <span>Find anything in your brain...</span>
            <kbd>&#8984; K</kbd>
          </Link>
          <button
            className={`mode-badge ${gomez.mode === "live" ? "live" : ""}`}
            type="button"
            title="Switch between demo (sample data) and live (your data)"
            onClick={() => gomez.setMode(gomez.mode === "demo" ? "live" : "demo")}
          >
            <span className="demo-dot" />
            <span>{gomez.mode === "demo" ? "Demo workspace" : "Live workspace"}</span>
          </button>
          <Link className="private-pill" href="/security">
            <Icon name="lock" />
            <span>Owner only</span>
          </Link>
          <Link className="icon-button top-settings" href="/security" aria-label="Settings">
            <Icon name="sliders" />
          </Link>
        </header>
        <div className="workspace-body">
          <main className="main-area" id="mainArea">
            <section className="page-heading">
              <div>
                <div className="eyebrow">CONTEXT. CLARITY. CONTROL.</div>
                <h1>
                  {title[0]}
                  <span>.</span>
                </h1>
                <p>{title[1]}</p>
              </div>
              {base === "/" ? (
                <Link className="button primary add-source-button" href="/connections">
                  <Icon name="plus" />
                  Add source
                </Link>
              ) : base === "/memories" || base === "/search" ? (
                <button className="button primary add-source-button" type="button" onClick={() => gomez.openModal(<AddNoteModal />)}>
                  <Icon name="plus" />
                  Add note
                </button>
              ) : null}
            </section>
            {children}
          </main>
          <AgentPanel />
        </div>
      </div>
      <button className="mobile-agent-button" type="button" onClick={() => gomez.setAgentOpen(true)}>
        <Icon name="sparkles" />
        Ask Gomez
      </button>
      <ModalHost />
      <Toasts />
    </div>
  );
}
