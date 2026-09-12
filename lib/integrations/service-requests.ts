import { PROVIDERS } from "./registry";

export type ServiceRequestClassification =
  | "existing_connector"
  | "connector_can_be_prepared"
  | "manual_investigation_required"
  | "unsupported";

export interface ClassificationResult {
  status: ServiceRequestClassification;
  matchedProvider: string | null;
  notes: string;
}

/**
 * Deterministic first-pass classification for "Add a service" requests.
 * No network, no package installs, no code execution. A future Claude worker
 * may refine a request through a reviewed Git branch.
 */
const KNOWN_OFFICIAL_APIS: Record<string, { aliases: string[]; method: string }> = {
  quickbooks: { aliases: ["quickbooks", "qbo", "intuit"], method: "OAuth 2.0 (Intuit Developer) — read-only accounting scopes" },
  xero: { aliases: ["xero"], method: "OAuth 2.0 — accounting.transactions.read" },
  hubspot: { aliases: ["hubspot"], method: "OAuth 2.0 (private/public app) — crm.objects.*.read scopes" },
  zoom: { aliases: ["zoom"], method: "OAuth 2.0 — meeting:read, recording:read" },
  calendly: { aliases: ["calendly"], method: "OAuth 2.0 — read scheduled events" },
  linear: { aliases: ["linear"], method: "OAuth 2.0 — read scope" },
  asana: { aliases: ["asana"], method: "OAuth 2.0 — default read" },
  trello: { aliases: ["trello"], method: "OAuth 1.0a / API key+token — read" },
  airtable: { aliases: ["airtable"], method: "OAuth 2.0 — data.records:read" },
  dropbox: { aliases: ["dropbox"], method: "OAuth 2.0 — files.metadata.read, files.content.read" },
  microsoft: { aliases: ["microsoft 365", "office 365", "outlook", "onedrive", "teams", "sharepoint"], method: "Microsoft identity platform OAuth 2.0 — Mail.Read, Files.Read, Calendars.Read" },
  google_ads: { aliases: ["google ads", "adwords"], method: "Google OAuth 2.0 + Google Ads API (developer token required)" },
  google_analytics: { aliases: ["google analytics", "ga4"], method: "Google OAuth 2.0 — analytics.readonly" },
  youtube: { aliases: ["youtube"], method: "Google OAuth 2.0 — youtube.readonly" },
  tiktok: { aliases: ["tiktok"], method: "TikTok for Business OAuth — ads reporting (app review required)" },
  linkedin: { aliases: ["linkedin"], method: "LinkedIn OAuth 2.0 — r_organization_social (partner approval may be required)" },
  twilio: { aliases: ["twilio"], method: "API key (read-only subaccount recommended)" },
  sendgrid: { aliases: ["sendgrid"], method: "API key with read-only stats scope" },
  mailchimp: { aliases: ["mailchimp"], method: "OAuth 2.0 — read audience/campaign reports" },
  shopify: { aliases: ["shopify"], method: "OAuth 2.0 (custom app) — read_orders, read_products" },
  square: { aliases: ["square"], method: "OAuth 2.0 — PAYMENTS_READ, ORDERS_READ" },
  paypal: { aliases: ["paypal"], method: "REST API OAuth client credentials — reporting" },
  jobber: { aliases: ["jobber"], method: "OAuth 2.0 (GraphQL API) — read scopes" },
  housecall: { aliases: ["housecall pro", "housecallpro"], method: "API key — read jobs/customers (plan-dependent)" },
  servicetitan: { aliases: ["servicetitan"], method: "OAuth client credentials — read scopes (app approval required)" },
  zapier: { aliases: ["zapier"], method: "No general read API; use Zapier webhooks into Jeff instead" },
  discord: { aliases: ["discord"], method: "Bot token with read message history for selected channels" },
  vercel: { aliases: ["vercel"], method: "Vercel REST API token (read-only scope) — deployments/logs" },
  cloudflare: { aliases: ["cloudflare"], method: "API token with read-only zone/analytics permissions" },
};

export function classifyServiceRequest(serviceName: string, desiredCapability: string): ClassificationResult {
  const q = `${serviceName} ${desiredCapability}`.toLowerCase();
  // Refusals first: a request can name an existing connector and still ask for something Jeff never does.
  if (/scrape|crawl|browser automation|headless|login as me|password/i.test(q)) {
    return {
      status: "unsupported",
      matchedProvider: null,
      notes: "Requests that require scraping, browser automation, or sharing passwords are not supported. Jeff only uses official APIs with explicit authorization.",
    };
  }
  const existing = PROVIDERS.find(
    (p) =>
      q.includes(p.id) ||
      q.includes(p.name.toLowerCase()) ||
      p.capabilities.some((c) => q.includes(c.name.toLowerCase())) ||
      (p.id === "highlevel" && /leadconnector|gohighlevel|ghl/.test(q)) ||
      (p.id === "plaid" && /bank|financial account|transactions/.test(q)) ||
      (p.id === "meta" && /facebook|instagram|meta ads/.test(q)) ||
      (p.id === "google" && /gmail|google drive|google calendar/.test(q)),
  );
  if (existing) {
    return {
      status: "existing_connector",
      matchedProvider: existing.id,
      notes: `${existing.name} is already in the Connections catalog. Use its setup flow; no new connector is needed.`,
    };
  }
  const known = Object.entries(KNOWN_OFFICIAL_APIS).find(([, v]) => v.aliases.some((a) => q.includes(a)));
  if (known) {
    const [key, v] = known;
    if (key === "zapier") return { status: "manual_investigation_required", matchedProvider: null, notes: v.method };
    return {
      status: "connector_can_be_prepared",
      matchedProvider: null,
      notes: `Official method: ${v.method}. A connector can be prepared through a reviewed Git branch using the OAuth/API-key adapter pattern in lib/integrations/providers.`,
    };
  }
  return {
    status: "manual_investigation_required",
    matchedProvider: null,
    notes: "No known official API mapping yet. Jeff will research the vendor's official integration method before preparing anything.",
  };
}
