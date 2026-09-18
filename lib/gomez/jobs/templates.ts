import { SYSTEM_JOBS, type TemplateCategory } from "./registry";
import type { JobInput } from "./types";

/**
 * Template catalog for "+ Add Job → Browse templates". System templates
 * point at the built-in roster; scaffolds are starting points for user jobs
 * with a constrained set of allowed detectors.
 */

export interface JobTemplate {
  id: string;
  category: TemplateCategory;
  name: string;
  description: string;
  /** Slug of the system job this template represents (open/enable it), if any. */
  system_slug?: string;
  /** Starting point for a new user job. */
  scaffold?: Partial<JobInput> & { detectors: string[]; sources: string[] };
}

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Sales", "Finance", "Operations", "Clients", "Relationships", "Personal", "Goals", "Productivity", "Automation", "Follow-Through"];

const SCAFFOLDS: JobTemplate[] = [
  {
    id: "client-scope-creep",
    category: "Clients",
    name: "Client Scope Creep Auditor",
    description: "Every Friday, compare each client's share of delivery work with its share of collected revenue.",
    scaffold: { slug: "client-scope-creep-auditor", name: "Client Scope Creep Auditor", scope: "business", schedule_type: "weekly", schedule_expression: "fri 07:05", sources: ["portal", "stripe"], detectors: ["client_scope_creep"], notification_policy: { min_importance: "important", push: true, briefing_only: false, max_per_day: 3 }, config: { window_days: 30 } },
  },
  {
    id: "speed-to-lead",
    category: "Sales",
    name: "Speed-to-Lead Watch",
    description: "Hourly: leads that arrived and were not contacted.",
    scaffold: { slug: "speed-to-lead", name: "Speed-to-Lead Watch", scope: "business", schedule_type: "hourly", sources: ["portal", "highlevel"], detectors: ["lead_not_contacted", "lead_followup_gap"] },
  },
  {
    id: "payments-watch",
    category: "Finance",
    name: "Payments Watch",
    description: "Event-driven: failed payments and overdue invoices, pushed when important.",
    scaffold: { slug: "payments-watch", name: "Payments Watch", scope: "financial", schedule_type: "event_driven", sources: ["stripe"], detectors: ["failed_payment", "client_unpaid_invoice"] },
  },
  {
    id: "weekly-blind-spots",
    category: "Goals",
    name: "Weekly: what am I missing?",
    description: "Once a week, look for something important that has not been surfaced.",
    system_slug: "blind-spot-scanner",
  },
  {
    id: "calendar-load",
    category: "Productivity",
    name: "Calendar Load Check",
    description: "Weekly: days with too many events or too many booked hours.",
    scaffold: { slug: "calendar-load-check", name: "Calendar Load Check", scope: "all", schedule_type: "weekly", schedule_expression: "sun 17:00", sources: ["google"], detectors: ["operational_bottleneck"], notification_policy: { min_importance: "important", push: false, briefing_only: true, max_per_day: 2 } },
  },
];

export function listTemplates(): JobTemplate[] {
  const system: JobTemplate[] = SYSTEM_JOBS.map((j) => ({ id: `system:${j.slug}`, category: j.template_category, name: j.ui_name ?? j.name, description: j.description, system_slug: j.slug }));
  return [...system, ...SCAFFOLDS];
}

export function getTemplate(id: string): JobTemplate | undefined {
  return listTemplates().find((t) => t.id === id);
}
