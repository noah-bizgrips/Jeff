/**
 * Sample data for DEMO MODE ONLY. Every record is flagged `sample: true`.
 * Live mode never reads this file's records into analysis.
 */
export interface JeffDoc {
  id: string;
  source: string; // visual source id (lib/jeff/sources)
  title: string;
  author: string;
  content: string;
  tags: string[];
  updated: string;
  url: string;
  sample: boolean;
}

const RAW: [string, string, string, string, string[], string][] = [
  [
    "github",
    "Lead intake / duplicate-event test",
    "Example repository / lead-intake",
    "SAMPLE: Repeated delivery of one event currently creates two contacts. Proposed fix: use an idempotency key, with tests for repeated events and genuinely new leads. No real repository is connected.",
    ["operations", "leads", "automation", "duplicates"],
    "2026-09-08T18:00:00Z",
  ],
  [
    "n8n",
    "Lead intake / workflow review",
    "Example workflow / lead intake",
    "SAMPLE: An intake workflow needs a duplicate-event guard. Test in an isolated environment with synthetic contacts. Publishing is not authorized. No real n8n instance is connected.",
    ["operations", "leads", "automation", "duplicates"],
    "2026-09-08T17:55:00Z",
  ],
  [
    "gmail",
    "Atlas launch: green light from the client",
    "Oliver Chen",
    "The Atlas client approved the direction on September 8. The revised proposal needs to be sent by Thursday, September 10. Please confirm the final implementation scope with Maya before sending. Budget remains $18,000.",
    ["atlas", "projects", "approval", "deadline", "people"],
    "2026-09-08T15:42:00Z",
  ],
  [
    "slack",
    "One thing blocking the Atlas launch",
    "#project-atlas",
    "Maya: The Atlas build is ready for review, but the production API credentials are still missing. Jordan owns the access request. We need credentials by Thursday, September 10 to stay on track for the September 18 launch.",
    ["atlas", "projects", "blocked", "deadline"],
    "2026-09-08T15:20:00Z",
  ],
  [
    "drive",
    "Atlas / Proposal v3",
    "Client projects / Atlas",
    "Project Atlas implementation proposal. Total fee: $18,000. Scope includes a unified knowledge interface, six data-source integrations, and an AI assistant. Milestones: scope approval September 10, review September 15, launch September 18. Owner: Maya.",
    ["atlas", "projects", "proposal", "deadline"],
    "2026-09-08T14:50:00Z",
  ],
  [
    "notion",
    "A better way to capture ideas",
    "Personal / Idea garden",
    "Idea: Make capturing a thought as easy as sending a message. Every note should have one clear idea, a descriptive title, and a few useful tags. Connect related thoughts across projects instead of creating more folders.",
    ["ideas", "knowledge", "capture"],
    "2026-09-08T14:25:00Z",
  ],
  [
    "leadconnector",
    "Sam Rivera / Estimate follow-up",
    "Pipeline / Estimate sent",
    "Sam Rivera requested a revised fence installation estimate. Quote value: $8,400. Stage: Estimate sent. Next action: send the material comparison and follow up on September 10. Preferred contact: email. The client is comparing cedar with composite.",
    ["people", "clients", "follow-up", "deadline", "sales"],
    "2026-09-08T14:00:00Z",
  ],
  [
    "calendar",
    "Atlas / Scope alignment",
    "Wednesday, September 9 / 10:00 AM Mountain",
    "Atlas scope alignment is scheduled for September 9, 2026 at 10:00 AM America/Denver, for 30 minutes. Attendees: Maya, Jordan, and Oliver. Agenda: confirm scope, unblock production credentials, and review the $18,000 proposal.",
    ["atlas", "projects", "meeting", "people"],
    "2026-09-09T16:00:00Z",
  ],
  [
    "gmail",
    "Weekly operations: decisions to review",
    "Maya Patel",
    "This week: finish the Atlas scope review, confirm the Northstar onboarding date, and choose a reporting format. Please review the weekly operating notes before the Friday team check-in.",
    ["operations", "deadline", "projects"],
    "2026-09-07T20:10:00Z",
  ],
  [
    "slack",
    "Northstar onboarding checklist is ready",
    "#client-success",
    "Riley: The Northstar onboarding checklist is ready in Notion. Waiting on the client to confirm access to their CRM. Target onboarding date is September 14. Jamie is the project owner.",
    ["northstar", "projects", "clients", "blocked"],
    "2026-09-07T19:35:00Z",
  ],
  [
    "drive",
    "Q3 growth experiments",
    "Strategy / Experiments",
    "Three experiments to prioritize: a faster inbound lead response, a clearer booking flow, and reactivation of older inquiries. Measure booked estimates, time to first response, and cost per qualified conversation. Review outcomes weekly.",
    ["ideas", "growth", "sales", "projects"],
    "2026-09-07T17:00:00Z",
  ],
  [
    "notion",
    "Atlas / Launch plan",
    "Projects / Atlas",
    "Launch target: September 18, 2026. Maya leads implementation, Jordan owns integrations, and Oliver approves scope. Risks: missing production credentials and late changes to the proposal. All six integrations are required for the planned release.",
    ["atlas", "projects", "deadline", "people"],
    "2026-09-07T16:40:00Z",
  ],
  [
    "leadconnector",
    "Northstar / Discovery complete",
    "Pipeline / Discovery",
    "Northstar completed discovery. Estimated project value: $12,000. Contact: Jamie Brooks. Next action: confirm CRM access and book the September 14 onboarding. A proposal has not yet been signed.",
    ["northstar", "clients", "people", "sales", "follow-up"],
    "2026-09-07T15:00:00Z",
  ],
  [
    "calendar",
    "Weekly team check-in",
    "Friday, September 11 / 9:30 AM Mountain",
    "Weekly team check-in on September 11, 2026, 9:30-10:00 AM America/Denver. Agenda: Atlas launch readiness, Northstar onboarding, and ownership of open actions. Bring the operating notes and updated project checklist.",
    ["meeting", "operations", "projects"],
    "2026-09-11T15:30:00Z",
  ],
  [
    "gmail",
    "Re: Northstar next steps",
    "Jamie Brooks",
    "Thanks for the discovery call. We are aiming to start on September 14. I will send over the CRM access and our contact list. Please share the onboarding checklist so our team can prepare.",
    ["northstar", "clients", "people", "follow-up"],
    "2026-09-06T17:00:00Z",
  ],
  [
    "slack",
    "Client feedback worth remembering",
    "#wins-and-learnings",
    "Clients value seeing a clear next step more than a long progress update. For the next status report, start with what changed, what needs a decision, and who owns the next action.",
    ["ideas", "clients", "operations"],
    "2026-09-06T16:00:00Z",
  ],
  [
    "drive",
    "Client onboarding / Working playbook",
    "Operations / Playbooks",
    "Every onboarding needs: a named owner, access checklist, agreed outcomes, kickoff agenda, and a first-week milestone. Keep scope and billing decisions in the same shared document. Add meeting notes after each client call.",
    ["operations", "clients", "projects"],
    "2026-09-05T18:00:00Z",
  ],
  [
    "notion",
    "Northstar / Onboarding checklist",
    "Clients / Northstar",
    "Owner: Jamie. Target kickoff: September 14. Pending: CRM access, contact import, and scope approval. Ready: onboarding agenda, internal project channel, and first-week deliverables.",
    ["northstar", "clients", "projects", "deadline"],
    "2026-09-05T17:00:00Z",
  ],
  [
    "leadconnector",
    "Alex Morgan / New inquiry",
    "Pipeline / New lead",
    "Alex Morgan asked about a backyard privacy fence. Stage: New inquiry. Next action: offer two available estimate times. No quote has been prepared. Preferred contact: SMS. Owner: Riley.",
    ["sales", "people", "clients", "follow-up"],
    "2026-09-05T15:00:00Z",
  ],
  [
    "calendar",
    "Northstar / Tentative kickoff",
    "Monday, September 14 / 11:00 AM Mountain",
    "Tentative Northstar kickoff on September 14, 2026 at 11:00 AM America/Denver. Duration: 45 minutes. Pending client confirmation. Agenda: access checklist, agreed outcomes, owners, and first-week milestones.",
    ["northstar", "meeting", "clients", "projects"],
    "2026-09-14T17:00:00Z",
  ],
  [
    "gmail",
    "Reading list: connected thinking",
    "Personal notes",
    "Explore the idea of linking knowledge by context rather than by the app that holds it. Capture an idea once, connect it to a project, and make the original source easy to find.",
    ["ideas", "knowledge"],
    "2026-09-04T16:00:00Z",
  ],
  [
    "slack",
    "Decisions should have a home",
    "#operations",
    "Jordan: Let us keep one decision log per project. Link the original thread, state the decision, and name the owner. This avoids losing the why behind a choice when the conversation moves on.",
    ["ideas", "operations", "knowledge"],
    "2026-09-04T15:00:00Z",
  ],
  [
    "drive",
    "Brand voice / Notes",
    "Brand / Reference",
    "Voice principles: clear, useful, and human. Use specific language. Prefer concrete outcomes to abstract promises. Explain the next step. When writing for contractors, say paid ads instead of naming individual ad platforms.",
    ["ideas", "brand", "operations"],
    "2026-09-03T17:00:00Z",
  ],
  [
    "notion",
    "Weekly reflection / Make space to think",
    "Personal / Reflections",
    "What worked: blocking time to review decisions and connect ideas. What to improve: fewer scattered notes and a single place to ask questions. Experiment: a fifteen-minute weekly knowledge review.",
    ["ideas", "knowledge", "reflection"],
    "2026-09-03T16:00:00Z",
  ],
  [
    "leadconnector",
    "Taylor Kim / Estimate booked",
    "Pipeline / Estimate booked",
    "Taylor Kim booked an estimate for a side-yard gate. Stage: Estimate booked. Appointment: September 12 at 1:00 PM America/Denver. Bring gate hardware options. Owner: Riley.",
    ["sales", "people", "clients"],
    "2026-09-03T15:00:00Z",
  ],
  [
    "calendar",
    "Focus time / Weekly review",
    "Friday, September 11 / 3:00 PM Mountain",
    "Weekly review on September 11, 2026 from 3:00-3:30 PM America/Denver. Review outstanding follow-ups, capture lessons, organize notes, and choose next week's three priorities.",
    ["meeting", "ideas", "reflection"],
    "2026-09-11T21:00:00Z",
  ],
];

export const SEED_DOCS: JeffDoc[] = RAW.map((d, i) => ({
  id: `demo-${i + 1}`,
  source: d[0],
  title: d[1],
  author: d[2],
  content: d[3],
  tags: d[4],
  updated: d[5],
  url: "",
  sample: true,
}));

export interface DemoInsight {
  id: string;
  label: string;
  title: string;
  body: string;
  evidence: string;
  goal: string;
  source: string;
}
export const DEMO_INSIGHTS: DemoInsight[] = [
  {
    id: "duplicates",
    label: "WORKFLOW RELIABILITY",
    title: "A repeated event should not create a second lead.",
    body: "Example: a workflow needs a duplicate-event guard. Connect the technical evidence to a scoped repair, not an unsupervised production edit.",
    evidence: "2 sample sources / GitHub + n8n",
    goal: "Investigate duplicate contacts in lead intake. Prepare an idempotency fix and synthetic tests; do not publish.",
    source: "github",
  },
  {
    id: "followup",
    label: "REVENUE OPERATIONS",
    title: "Make the next follow-up unambiguous.",
    body: "Example: an estimate has a next action but no confirmed owner. Prepare a review queue before approving any outreach.",
    evidence: "1 sample CRM record / no revenue-loss estimate",
    goal: "Prepare a report of estimates needing follow-up, with evidence and explicit owners. Do not send messages.",
    source: "leadconnector",
  },
  {
    id: "handoffs",
    label: "DELIVERY & HANDOFFS",
    title: "Surface what a launch is waiting for.",
    body: "Example: an access request is blocking a launch. Draft the dependency checklist and owner handoff without copying credentials into tasks.",
    evidence: "Sample messages / missing evidence is not failure",
    goal: "Analyze onboarding dependencies and prepare an access checklist using secret references only.",
    source: "slack",
  },
  {
    id: "health",
    label: "MONITORING HEALTH",
    title: "A quiet monitor is not proof that all is well.",
    body: "No source is live in this build. Data freshness, notification delivery, and worker health must be verified before trusting operational alerts.",
    evidence: "Current build status / no real background monitors",
    goal: "Design a source-freshness and workflow-health monitor with explicit stale-data warnings.",
    source: "n8n",
  },
];

export interface DemoMission {
  id: string;
  title: string;
  goal: string;
  status: "draft" | "review" | "blocked" | "approved" | "cancelled";
  tool: string;
  budget: number;
  minutes: number;
  created: string;
  sample: boolean;
}
export const DEMO_MISSIONS: DemoMission[] = [
  {
    id: "DEMO-001",
    title: "Prevent duplicate contacts in lead intake",
    goal: "Investigate repeated webhook events and prepare an idempotency guard. Use synthetic contacts only.",
    status: "review",
    tool: "n8n + GitHub",
    budget: 5,
    minutes: 15,
    created: "Example",
    sample: true,
  },
  {
    id: "DEMO-002",
    title: "Prepare a daily lead follow-up report",
    goal: "Define response-delay rules, an owner queue, and a daily report without messaging real prospects.",
    status: "draft",
    tool: "n8n",
    budget: 3,
    minutes: 10,
    created: "Example",
    sample: true,
  },
  {
    id: "DEMO-003",
    title: "Review onboarding handoff delays",
    goal: "Compare handoff timestamps and propose a checklist. Do not infer missing completion evidence as failure.",
    status: "blocked",
    tool: "Claude Code",
    budget: 5,
    minutes: 15,
    created: "Example",
    sample: true,
  },
];
