"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, SourceIcon } from "./icons";
import { useJeff } from "./store";
import { ModalHost, Toasts, AddNoteModal } from "./shared";
import { AgentPanel } from "@/components/assistant/AgentPanel";
import { sourceDef } from "@/lib/jeff/sources";

const NAV: { href: string; icon: string; label: string; end?: "home" | "missions" | "approvals" | "key" | "memories" | "saved" }[] = [
  { href: "/", icon: "network", label: "Mission control", end: "home" },
  { href: "/missions", icon: "compose", label: "Missions", end: "missions" },
  { href: "/insights", icon: "sun", label: "Operations & insights" },
  { href: "/approvals", icon: "check", label: "Approvals", end: "approvals" },
  { href: "/search", icon: "search", label: "Search everything", end: "key" },
  { href: "/memories", icon: "layers", label: "Memories", end: "memories" },
  { href: "/saved", icon: "bookmark", label: "Saved answers", end: "saved" },
  { href: "/connections", icon: "plug", label: "Connections" },
  { href: "/security", icon: "lock", label: "Security & access" },
];

const TITLES: Record<string, [string, string, string]> = {
  "/": ["Your business. In focus", "Connect your knowledge. Turn the next right idea into action.", "Mission control"],
  "/missions": ["From intent to action", "Draft, review, and track work. No hidden production changes.", "Missions"],
  "/insights": ["Find the next improvement", "Evidence first. A specific action next. Outcomes after.", "Operations & insights"],
  "/approvals": ["The important decisions are yours", "Review the exact change before anything leaves the sandbox.", "Approvals"],
  "/connections": ["Bring your tools together", "Knowledge sources and execution tools, with separate permissions.", "Connections"],
  "/security": ["Private by design", "Your identity. Your boundaries. No pretend security badges.", "Security & access"],
  "/search": ["A little less searching", "Find the right thought, no matter where it lives.", "Search everything"],
  "/memories": ["Everything you remember", "Your messages, documents, and ideas. All connected.", "Memories"],
  "/saved": ["Worth coming back to", "The answers and insights you chose to keep.", "Saved answers"],
};

export function AppShell({ children }: { children: ReactNode }) {
  const jeff = useJeff();
  const pathname = usePathname();
  const base = "/" + (pathname.split("/")[1] ?? "");
  const title = TITLES[base] ?? TITLES["/"]!;
  const ids = jeff.connectedSources();
  const docCount = jeff.docs().length;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        jeff.closeModal();
        jeff.navigate("/search");
      }
      if (e.key === "Escape") {
        jeff.setAgentOpen(false);
        jeff.setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [jeff]);

  return (
    <div className="app">
      <aside className={`sidebar ${jeff.sidebarOpen ? "open" : ""}`} id="sidebar">
        <Link className="brand" href="/" aria-label="Jeff home">
          <span className="brand-symbol">
            <Icon name="brain" />
          </span>
          <span>
            Jeff<span className="brand-period">.</span>
          </span>
        </Link>
        <Link className="workspace-switch" href="/security">
          <span className="workspace-avatar">N</span>
          <span>
            <strong>My workspace</strong>
            <small>Jeff / Second brain</small>
          </span>
          <Icon name="chevrons" className="muted" />
        </Link>
        <div className="nav-label">COMMAND CENTER</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`nav-item ${base === n.href ? "active" : ""}`} onClick={() => jeff.setSidebarOpen(false)}>
              <Icon name={n.icon} />
              {n.label}
              {n.end === "home" ? <span className="nav-end small-pill">Home</span> : null}
              {n.end === "missions" ? <span className="nav-end nav-count">{jeff.missionCount}</span> : null}
              {n.end === "approvals" && jeff.approvalCount > 0 ? <span className="nav-end review-dot">{jeff.approvalCount}</span> : null}
              {n.end === "key" ? <span className="nav-end keycap">K</span> : null}
              {n.end === "memories" ? <span className="nav-end nav-count">{docCount}</span> : null}
              {n.end === "saved" ? <span className="nav-end nav-count">{jeff.saved.length}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="nav-label source-label">
          {jeff.mode === "demo" ? "SAMPLE SOURCES" : "CONNECTED SOURCES"}
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
                className={`source-item ${jeff.focusSource === id ? "selected" : ""}`}
                title={`Explore ${sourceDef(id).name} memories`}
                onClick={() => {
                  jeff.setFocusSource(jeff.focusSource === id ? null : id);
                  if (base !== "/") jeff.navigate("/");
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
            <span>{jeff.mode === "demo" ? "Sample workspace / no live access" : `${ids.length} sources in your live workspace`}</span>
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

      <div className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" aria-label="Toggle navigation" onClick={() => jeff.setSidebarOpen(!jeff.sidebarOpen)}>
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
            className={`mode-badge ${jeff.mode === "live" ? "live" : ""}`}
            type="button"
            title="Switch between demo (sample data) and live (your data)"
            onClick={() => jeff.setMode(jeff.mode === "demo" ? "live" : "demo")}
          >
            <span className="demo-dot" />
            <span>{jeff.mode === "demo" ? "Demo workspace" : "Live workspace"}</span>
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
                <button className="button primary add-source-button" type="button" onClick={() => jeff.openModal(<AddNoteModal />)}>
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
      <button className="mobile-agent-button" type="button" onClick={() => jeff.setAgentOpen(true)}>
        <Icon name="sparkles" />
        Ask Jeff
      </button>
      <ModalHost />
      <Toasts />
    </div>
  );
}
