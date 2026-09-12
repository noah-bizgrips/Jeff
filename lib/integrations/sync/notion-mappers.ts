import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";

/**
 * Pure mappers from Notion API (version 2022-06-28) objects to source_items.
 *
 * Shapes verified against the Notion reference:
 *   POST /v1/search           → { results: (page | database)[], next_cursor, has_more }
 *   page                      → { id, url, created_time, last_edited_time, icon?, parent: { type, database_id? | page_id? | workspace? }, properties }
 *   database                  → { id, url, title: rich_text[], properties: { [name]: { type } } }
 *   GET /v1/blocks/:id/children → { results: block[] } where block[block.type].rich_text holds the text
 *
 * Only titles, short excerpts and select/status/date property values are
 * stored; never full page bodies.
 */

export interface RichText {
  plain_text?: string;
}

export interface NotionProperty {
  type?: string;
  title?: RichText[];
  rich_text?: RichText[];
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  multi_select?: { name?: string }[];
  date?: { start?: string | null; end?: string | null } | null;
  checkbox?: boolean;
  number?: number | null;
  url?: string | null;
}

export interface NotionPage {
  object: "page";
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  icon?: { type?: string; emoji?: string } | null;
  parent?: { type?: string; database_id?: string; page_id?: string; workspace?: boolean } | null;
  properties?: Record<string, NotionProperty>;
}

export interface NotionDatabase {
  object: "database";
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  title?: RichText[];
  properties?: Record<string, { type?: string }>;
}

export interface NotionBlock {
  type?: string;
  [key: string]: unknown;
}

export function plain(rt: RichText[] | undefined): string {
  return (rt ?? []).map((r) => r.plain_text ?? "").join("");
}

export function truncate(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Title = the property of type "title" regardless of its name (Name, Title, Task, …). */
export function pageTitle(p: NotionPage): string {
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop?.type === "title") {
      const t = plain(prop.title).trim();
      if (t) return t;
    }
  }
  return "Untitled";
}

/** Names + values of select/status/multi_select/date/checkbox/number properties. Text properties are excluded (bodies live elsewhere). */
export function propertySummary(p: NotionPage): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [name, prop] of Object.entries(p.properties ?? {})) {
    if (!prop || Object.keys(out).length >= 20) continue;
    switch (prop.type) {
      case "select":
        out[name] = prop.select?.name ?? null;
        break;
      case "status":
        out[name] = prop.status?.name ?? null;
        break;
      case "multi_select":
        out[name] = (prop.multi_select ?? []).map((m) => m.name ?? "").filter(Boolean).join(", ") || null;
        break;
      case "date":
        out[name] = prop.date?.start ? `${prop.date.start}${prop.date.end ? ` → ${prop.date.end}` : ""}` : null;
        break;
      case "checkbox":
        out[name] = !!prop.checkbox;
        break;
      case "number":
        out[name] = prop.number ?? null;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Text from a list of child blocks (paragraphs, headings, lists, quotes, callouts, to-dos). */
export function blocksText(blocks: NotionBlock[], max = 400): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const t = b.type;
    if (!t) continue;
    const inner = b[t] as { rich_text?: RichText[]; checked?: boolean } | undefined;
    const text = plain(inner?.rich_text).trim();
    if (!text) continue;
    parts.push(t === "to_do" ? `[${inner?.checked ? "x" : " "}] ${text}` : text);
    if (parts.join(" ").length >= max) break;
  }
  return truncate(parts.join(" "), max);
}

export function mapPage(p: NotionPage, opts: { excerpt?: string | null; databaseTitles?: Map<string, string> } = {}): SourceItemInput | null {
  if (p.archived || p.in_trash) return null;
  const title = pageTitle(p);
  const parentType = p.parent?.type ?? "unknown";
  const parentId = p.parent?.database_id ?? p.parent?.page_id ?? null;
  const dbTitle = p.parent?.database_id ? (opts.databaseTitles?.get(p.parent.database_id) ?? null) : null;
  const props = propertySummary(p);
  const propLine = Object.entries(props)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
  const summary = truncate([opts.excerpt ?? "", propLine].filter(Boolean).join(" — "), 400) || null;
  return {
    provider: "notion",
    capability: "pages",
    resource_type: "page",
    external_id: p.id,
    title,
    summary,
    author: null,
    source_url: p.url ?? null,
    source_timestamp: p.last_edited_time ?? p.created_time ?? null,
    content_hash: createHash("sha256").update(`${title}|${summary ?? ""}`).digest("hex"),
    tags: ["notion", ...(dbTitle ? [dbTitle.toLowerCase()] : [])],
    metadata: {
      parent_type: parentType,
      parent_id: parentId,
      database_title: dbTitle,
      last_edited_time: p.last_edited_time ?? null,
      created_time: p.created_time ?? null,
      url: p.url ?? null,
      icon: p.icon?.type === "emoji" ? (p.icon.emoji ?? null) : null,
      properties: props,
    },
  };
}

export function mapDatabase(d: NotionDatabase): SourceItemInput | null {
  if (d.archived || d.in_trash) return null;
  const title = plain(d.title).trim() || "Untitled database";
  const propNames = Object.keys(d.properties ?? {}).slice(0, 40);
  return {
    provider: "notion",
    capability: "pages",
    resource_type: "database",
    external_id: d.id,
    title,
    summary: propNames.length ? `Properties: ${propNames.join(", ")}` : null,
    author: null,
    source_url: d.url ?? null,
    source_timestamp: d.last_edited_time ?? d.created_time ?? null,
    content_hash: createHash("sha256").update(`${title}|${propNames.join(",")}`).digest("hex"),
    tags: ["notion", "database"],
    metadata: { property_names: propNames, url: d.url ?? null, last_edited_time: d.last_edited_time ?? null },
  };
}
