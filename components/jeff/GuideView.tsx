"use client";

import Link from "next/link";
import { Icon } from "./icons";

interface Section {
  id: string;
  icon: string;
  title: string;
  what: string;
  how: string[];
  tips?: string[];
  href?: string;
}

const SECTIONS: Section[] = [
  {
    id: "concepts",
    icon: "brain",
    title: "How Jeff thinks",
    what: "Jeff is a private operating partner. It reads the systems you connect, keeps quiet by default, and surfaces what deserves attention — then adapts when you correct it.",
    how: [
      "GOALS are outcomes you want by a date (\"10 new clients in 60 days\"). They are measured from your data, not ticked off by hand.",
      "MISSIONS are finite pieces of work that move a goal or fix a finding. They go draft → review → approval → done, and their outcome is measured afterwards.",
      "FINDINGS are things Jeff noticed: overdue tasks, quiet leads, failed payments, cash-flow shifts. Each one separates observed facts, calculated metrics, and interpretation.",
      "ALERTS are findings important enough to interrupt you. BRIEFINGS are the scheduled summaries. MEMORY & RULES are what Jeff has learned about how you want it to behave.",
    ],
    tips: ["Everything Jeff does is read-only unless you approve a mission. It never moves money, messages customers, or changes production on its own."],
  },
  {
    id: "mission-control",
    icon: "network",
    title: "Mission control",
    what: "The home screen. In Live mode it leads with what needs your attention, goals at risk, opportunities, today's schedule and commitments, and active missions. The brain graph shows your connected sources and recent memories.",
    how: [
      "Use the command box at the top: Prepare creates a mission draft from a sentence; Ask sends it to Jeff; Run approved checks whether anything is ready to execute.",
      "Click a source bubble on the graph to focus the memories from that source; click a memory to open it with its connected thoughts.",
      "Demo / Live badge (top bar): Demo shows sample data only; Live shows your synced records. Nothing sample ever mixes into live analysis.",
    ],
    href: "/",
  },
  {
    id: "connections",
    icon: "plug",
    title: "Connections",
    what: "Where you authorize the services Jeff may read. A connection is marked Connected only after a harmless real test succeeds.",
    how: [
      "Connection setup → Authorize opens the provider's own consent screen with read-only permissions. Secrets are never typed into chat; keys like Stripe's restricted key go into the protected form and are encrypted immediately.",
      "Manage → Test re-runs the verification; Sync now pulls new records; Select accounts (Meta/GitHub) limits what Jeff may analyze; Remove deletes the credential and everything synced from it.",
      "Add a service: type a tool and what you want; Jeff classifies whether an official integration exists and records the request. Nothing is installed automatically.",
      "Syncs also run automatically every 30 minutes, followed by monitors and alerts.",
    ],
    href: "/connections",
  },
  {
    id: "ask-jeff",
    icon: "sparkles",
    title: "Ask Jeff",
    what: "The chat panel on the right. Jeff answers from your data through narrow server-side tools — it never sees provider credentials, and retrieved content is treated as evidence, not instructions.",
    how: [
      "Ask questions: \"What should I focus on today?\", \"Which leads have gone quiet?\", \"Are we likely to hit the client goal?\", \"Find something we're doing stupidly.\"",
      "Give feedback and it changes behavior: \"Stop flagging GitHub notification emails as commitments\" creates a rule and cleans up existing findings; \"Remember I want briefs under five items\" stores a preference.",
      "Ask it to act within its boundaries: create a mission draft, propose a goal, snooze an alert, change a Tier-1 setting.",
      "Scope the conversation to one source with the selector above the composer. Save useful answers with Save answer.",
    ],
    tips: ["A daily AI budget cap (Settings / Security) protects your Anthropic spend. Jeff says so when it's reached."],
  },
  {
    id: "goals",
    icon: "target",
    title: "Goals",
    what: "Long-term outcomes tracked from real data with pace, forecast and the likely constraint.",
    how: [
      "New goal → type it in plain English. Jeff proposes metrics, sources, formulas, milestones, assumptions and the ambiguities it needs you to resolve (for example how CAC is defined).",
      "Resolve each ambiguity and Approve. The wording you typed is preserved; approved metric definitions are never changed silently.",
      "Each goal shows target vs current, days remaining, observed vs required pace, trajectory (On track → Severely at risk), the driver most likely holding it back, and recommendations you can Prepare into missions.",
      "Metrics that need a source you haven't connected show \"not connected\" rather than a misleading zero.",
    ],
    href: "/goals",
  },
  {
    id: "insights",
    icon: "sun",
    title: "Operations & insights",
    what: "The findings Jeff's monitors produce: lead follow-up gaps, pipeline aging, open commitments, calendar bottlenecks, failed payments, cash-flow and recurring-expense changes, ad spend anomalies, and client-portal issues.",
    how: [
      "The Active tab is your working list; Dismissed, Resolved and Suppressed by rules keep history without clutter.",
      "Dismiss on a tile removes it from Active; select several and Dismiss selected to clean up in bulk. Dismissed findings do not return unless the condition recurs with new evidence.",
      "Review opens the evidence (facts, metrics with formulas, interpretation, limitations, source links). Feedback buttons teach Jeff: Useful, Not useful, Wrong, Too noisy, Don't show this again (creates the narrowest safe rule), Change rule (opens the editor).",
      "Prepare a task draft turns a finding into a mission. Run monitors now re-checks everything against the latest synced data.",
    ],
    href: "/insights",
  },
  {
    id: "alerts",
    icon: "bell",
    title: "Alerts",
    what: "Findings, goal changes and overdue commitments important enough to interrupt you, with importance levels: Informational (stored), Briefing (next brief), Important (during the day), Urgent (now), Actionable (Jeff can prepare work).",
    how: [
      "Filter by importance, status or area (goal-related, financial, operations, clients, acquisition, personal).",
      "Actions: Investigate opens the source; Snooze hides it until a time; Dismiss; Prepare fix creates a mission; Change rule / Don't show this again adjusts future behavior.",
      "Duplicates are merged: the same condition updates one alert (with an occurrence count) instead of repeating. Resolved conditions resolve their alert automatically.",
      "Quiet hours and the minimum importance in Settings decide what can interrupt you; urgent items always surface.",
    ],
    href: "/alerts",
  },
  {
    id: "briefings",
    icon: "inbox",
    title: "Briefings",
    what: "Your Daily Brief (default 7:30 AM Denver), Weekly operating review (Monday) and Monthly owner review (1st). Built from evidence first, summarized once by Claude, and shaped by your rules and preferences.",
    how: [
      "Daily: the top things that need attention, goals, today (events and commitments), business signals, financial, and what Jeff recommends.",
      "Weekly emphasizes change versus the prior week and whether completed missions actually moved their metric. Monthly only reports metrics with enough data.",
      "Mark read or Save, ask Jeff about a brief, create a mission from a recommendation, or open the evidence behind any line.",
      "Generate one now from the Briefings page if you don't want to wait for the schedule.",
    ],
    href: "/briefings",
  },
  {
    id: "missions",
    icon: "compose",
    title: "Missions & approvals",
    what: "Bounded work items with a worker, budget and time limits. Production effects always wait for an approval bound to the exact artifact.",
    how: [
      "Create a draft from the command box, from a finding, or from a goal recommendation. Queue for sandbox worker moves it toward execution (sandbox only).",
      "Approvals lists anything that needs your explicit sign-off, with the exact action, artifact and environment. Approvals expire after an hour.",
      "Mark completed when the work is done; Jeff records a baseline and, 14 days later, whether the linked metric improved — phrased as \"following the change\", never as a causal claim.",
    ],
    href: "/missions",
  },
  {
    id: "memory",
    icon: "brain",
    title: "Memory & rules",
    what: "A transparent control center for what Jeff has learned. Memories are soft preferences that shape interpretation; rules are deterministic condition → action pairs enforced before any AI work.",
    how: [
      "Rules are created from chat, from finding feedback, or manually with Add rule. Each shows its plain-English summary, where it came from, when it last triggered and how often.",
      "Edit, disable, delete, view trigger history, reprocess existing findings, or undo a suppression. Conflicting rules are listed so nothing behaves unpredictably.",
      "Safety tiers: safe, reversible changes apply immediately; important behavioral changes ask for confirmation; security, access, approvals and money safeguards can never be changed by a rule.",
      "More specific rules win: \"ignore GitHub notifications\" plus \"alert me about production deploy failures\" means the deploy failures still get through.",
    ],
    href: "/memory",
  },
  {
    id: "search",
    icon: "search",
    title: "Search, Memories, Saved answers",
    what: "Everything Jeff has synced is searchable (⌘K), filterable by source, and connected by shared tags in Memories. Saved answers keeps the chat answers you chose to keep.",
    how: [
      "Search everything: type a person, project, or phrase; sort by relevance or recency; open the original in its source.",
      "Memories: browse by source or collection (Projects, People & clients, Ideas). Add your own notes; they become memories with tags.",
      "Saved answers: Save answer on any Jeff reply; remove it when it's no longer useful.",
    ],
    href: "/search",
  },
  {
    id: "settings",
    icon: "sliders",
    title: "Settings & security",
    what: "Settings controls timing and thresholds; Security & access shows the enforced protections and the audit log.",
    how: [
      "Settings: timezone, Daily Brief time, weekly/monthly reviews, quiet hours, minimum alert importance, goal/opportunity/business/personal/financial notification toggles, and whether Jeff may learn from feedback and auto-apply safe rules.",
      "Security & access: MFA status, owner binding, encryption, AI budget spend, connection count, and the audit trail of logins, connections, rules and approvals. Sign out revokes the session everywhere.",
      "Signing in always requires your password plus an authenticator code. There is no signup and no MFA bypass.",
    ],
    href: "/settings",
  },
];

export function GuideView() {
  return (
    <section className="page-view" id="guideView">
      <div className="preview-banner">
        <Icon name="info" />
        <span>
          <strong>Jeff stays quiet by default.</strong> It learns what matters to you, surfaces what matters when it matters, and adapts when corrected. This page explains each area and how to use it.
        </span>
      </div>
      <div className="filter-tabs" style={{ flexWrap: "wrap" }}>
        {SECTIONS.map((s) => (
          <a key={s.id} className="filter-tab" href={`#${s.id}`}>
            <Icon name={s.icon} />
            {s.title}
          </a>
        ))}
      </div>
      <div className="security-grid">
        {SECTIONS.map((s) => (
          <section className="security-card" id={s.id} key={s.id} style={{ scrollMarginTop: 80 }}>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name={s.icon} />
              {s.title}
            </h3>
            <p>{s.what}</p>
            <div className="section-label">HOW TO USE IT</div>
            <ul className="checklist">
              {s.how.map((h, i) => (
                <li key={i}>
                  <Icon name="check" />
                  {h}
                </li>
              ))}
            </ul>
            {s.tips?.length ? (
              <div className="callout" style={{ marginTop: 10 }}>
                {s.tips.map((t, i) => (
                  <p key={i}>{t}</p>
                ))}
              </div>
            ) : null}
            {s.href ? (
              <Link className="button secondary" href={s.href} style={{ marginTop: 12 }}>
                Open {s.title.toLowerCase()} <Icon name="arrowUpRight" />
              </Link>
            ) : null}
          </section>
        ))}
      </div>
      <div className="section-label">A GOOD FIRST WEEK</div>
      <ul className="checklist">
        <li>
          <Icon name="check" />
          Connect the sources you rely on (Google, HighLevel, Stripe, Slack are the highest value), then switch the top badge to Live.
        </li>
        <li>
          <Icon name="check" />
          Write one real goal on the Goals page and approve Jeff&apos;s interpretation.
        </li>
        <li>
          <Icon name="check" />
          Read the Daily Brief each morning; dismiss or correct what isn&apos;t useful — every correction becomes a rule or a memory.
        </li>
        <li>
          <Icon name="check" />
          When a finding is worth acting on, Prepare a mission; approve only what you have reviewed.
        </li>
      </ul>
    </section>
  );
}
