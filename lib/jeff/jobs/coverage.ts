import type { ProviderFreshness } from "@/lib/jeff/freshness";
import type { CoverageEntry, JobRow } from "./types";

/**
 * Coverage: for each source a job declares, is the data there and fresh?
 * Missing/stale sources are reported, never silently treated as "no data".
 */
export function computeCoverage(job: Pick<JobRow, "sources">, freshness: ProviderFreshness[]): CoverageEntry[] {
  const byProvider = new Map(freshness.map((f) => [f.provider, f]));
  return job.sources.map((source) => {
    const f = byProvider.get(source);
    if (!f || f.status === "not_configured") return { source, status: "missing", freshness: "not connected" };
    if (["error", "reconnect_required"].includes(f.status) || f.level === "error") return { source, status: "error", freshness: f.last_error ? "sync error" : f.text };
    if (f.level === "stale" || f.level === "never") return { source, status: "stale", freshness: f.text };
    return { source, status: "ok", freshness: f.text };
  });
}

export type CoverageLevel = "full" | "partial" | "none";

export function coverageLevel(entries: CoverageEntry[]): CoverageLevel {
  if (!entries.length) return "full";
  const ok = entries.filter((e) => e.status === "ok").length;
  if (ok === entries.length) return "full";
  if (ok === 0) return "none";
  return "partial";
}

/** Human note for a partial run, e.g. "Gmail unavailable; email checks skipped". */
export function coverageNotes(entries: CoverageEntry[], labels: Record<string, string> = {}): string[] {
  return entries
    .filter((e) => e.status !== "ok")
    .map((e) => {
      const name = labels[e.source] ?? e.source;
      if (e.status === "missing") return `${name} is not connected; checks that need it were skipped.`;
      if (e.status === "stale") return `${name} data is stale (${e.freshness}); conclusions that depend on it are uncertain.`;
      return `${name} is unavailable (${e.freshness}); its checks were skipped.`;
    });
}
