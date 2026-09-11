/**
 * Visual "source" definitions used by the brain graph, filters and memory
 * cards. These are the fine-grained categories the owner sees; the
 * Connections catalog (lib/integrations/registry) is the authorization unit.
 */
export interface SourceDef {
  id: string;
  name: string;
  color: string;
  desc: string;
  type: string;
  /** Registry provider that authorizes this source. */
  provider: string;
  capability?: string;
}

export const SOURCES: SourceDef[] = [
  { id: "gmail", name: "Gmail", color: "#75adff", desc: "Emails, conversations, and the details between the lines.", type: "Email", provider: "google", capability: "gmail" },
  { id: "slack", name: "Slack", color: "#9bafff", desc: "Team conversations, shared decisions, and quick updates.", type: "Message", provider: "slack" },
  { id: "leadconnector", name: "LeadConnector", color: "#6fdbff", desc: "Contacts, client conversations, and relationship context.", type: "Contact", provider: "highlevel" },
  { id: "notion", name: "Notion", color: "#c5dfff", desc: "Your wiki, project plans, and a home for every idea.", type: "Page", provider: "notion" },
  { id: "drive", name: "Google Drive", color: "#559bff", desc: "Documents, proposals, and all the work behind your work.", type: "Document", provider: "google", capability: "drive" },
  { id: "calendar", name: "Google Calendar", color: "#8bcbff", desc: "Meetings, upcoming events, and the context to show up ready.", type: "Event", provider: "google", capability: "calendar" },
  { id: "github", name: "GitHub", color: "#acd3ff", desc: "Repositories, pull requests, tests, and technical context.", type: "Repository", provider: "github" },
  { id: "n8n", name: "n8n", color: "#67d4ef", desc: "Workflow definitions, execution history, and approved routines.", type: "Workflow", provider: "n8n" },
  { id: "metaads", name: "Meta Ads", color: "#5b9dff", desc: "Campaign spend, delivery, attribution context, and advertising performance.", type: "Ad data", provider: "meta", capability: "ads" },
  { id: "facebook", name: "Facebook", color: "#79a9ff", desc: "Authorized Facebook Pages, content, engagement, and Page-level insights.", type: "Page data", provider: "meta", capability: "pages" },
  { id: "instagram", name: "Instagram", color: "#a788ff", desc: "Professional account content, engagement, conversations, and insights where authorized.", type: "Social data", provider: "meta", capability: "instagram" },
  { id: "stripe", name: "Stripe", color: "#8aa4ff", desc: "Payments, invoices, subscriptions, customers, disputes, and billing signals.", type: "Billing data", provider: "stripe" },
  { id: "plaid", name: "Financial Accounts", color: "#45c9ff", desc: "Read-only bank and credit-card balances, transactions, recurring expenses, and cash-flow signals via Plaid.", type: "Financial data", provider: "plaid" },
  { id: "notes", name: "Personal notes", color: "#80bdff", desc: "Your own thoughts, uploaded text, and saved inspiration.", type: "Note", provider: "notes" },
];

export const GRAPH_SOURCES = SOURCES.filter((s) => s.id !== "notes");

export function sourceDef(id: string): SourceDef {
  return SOURCES.find((s) => s.id === id) ?? SOURCES[SOURCES.length - 1]!;
}

/** Maps a synced record (provider + capability) to its visual source id. */
export function sourceIdFor(provider: string, capability?: string | null): string {
  const exact = SOURCES.find((s) => s.provider === provider && (s.capability ?? null) === (capability ?? null));
  if (exact) return exact.id;
  const byProvider = SOURCES.find((s) => s.provider === provider);
  return byProvider?.id ?? "notes";
}

export function hexRgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
