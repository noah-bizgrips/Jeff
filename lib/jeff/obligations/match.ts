/**
 * Fuzzy obligation matching for Ask Jeff ("snooze the Calendly cancellation",
 * "mark the dentist thing done"). Pure. Title words are matched by stem /
 * prefix so "cancellation" finds "Cancel Calendly" and "dentist" finds
 * "Dentist appointment"; counterparty and description count at half weight.
 */

const STOP = new Set(["the", "that", "this", "thing", "about", "with", "for", "and", "one", "item", "task", "reminder", "obligation", "please", "mark", "done", "snooze", "until", "dismiss", "cancel", "complete", "finish", "stop", "tracking", "remind", "reminding", "did", "you", "was", "it"]);

export function stem(w: string): string {
  let s = w.toLowerCase();
  for (const suf of ["ations", "ation", "ing", "ies", "ed", "es", "s"]) {
    if (s.length - suf.length >= 4 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      if (suf === "ies") s += "y";
      break;
    }
  }
  return s.replace(/(.)\1$/, "$1");
}

export function tokens(text: string, keepStop = false): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$@.'-]+/)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, "").replace(/'s$/, ""))
    .filter((w) => w.length >= 3 && (keepStop || !STOP.has(w)))
    .map(stem);
}

function tokenMatches(q: string, t: string): boolean {
  if (q === t) return true;
  const shorter = q.length <= t.length ? q : t;
  const longer = shorter === q ? t : q;
  return shorter.length >= 4 && longer.startsWith(shorter);
}

export interface Matchable {
  id: string;
  title: string;
  counterparty?: string | null;
  description?: string | null;
}

export interface MatchScore<T extends Matchable> {
  item: T;
  score: number;
  matched: string[];
}

/** Scores every row against the query; 0 = no overlap, 1 = every query word found in the title. */
export function scoreMatches<T extends Matchable>(query: string, rows: T[]): MatchScore<T>[] {
  let q = tokens(query);
  if (!q.length) q = tokens(query, true);
  if (!q.length) return [];
  const out: MatchScore<T>[] = [];
  for (const item of rows) {
    const title = tokens(item.title, true);
    const secondary = tokens(`${item.counterparty ?? ""} ${item.description ?? ""}`, true);
    let score = 0;
    const matched: string[] = [];
    for (const w of q) {
      if (title.some((t) => tokenMatches(w, t))) {
        score += 1;
        matched.push(w);
      } else if (secondary.some((t) => tokenMatches(w, t))) {
        score += 0.5;
        matched.push(w);
      }
    }
    if (score > 0) out.push({ item, score: Math.round((score / q.length) * 1000) / 1000, matched });
  }
  return out.sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length);
}

export type MatchResult<T extends Matchable> = { ok: true; item: T; score: number } | { ok: false; error: "no_matching_obligation" | "ambiguous_match"; candidates?: { id: string; title: string }[] };

export const MIN_MATCH_SCORE = 0.34;

/** Best match, or ambiguity when the top two are tied, or nothing when the overlap is too thin. */
export function bestMatch<T extends Matchable>(query: string, rows: T[]): MatchResult<T> {
  const scored = scoreMatches(query, rows).filter((s) => s.score >= MIN_MATCH_SCORE);
  if (!scored.length) return { ok: false, error: "no_matching_obligation" };
  const [top, second] = scored;
  if (second && second.score === top!.score && second.matched.length === top!.matched.length) {
    return { ok: false, error: "ambiguous_match", candidates: scored.slice(0, 5).map((s) => ({ id: s.item.id, title: s.item.title })) };
  }
  return { ok: true, item: top!.item, score: top!.score };
}
