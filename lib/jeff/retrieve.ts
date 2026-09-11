import type { JeffDoc } from "./demo-data";

const STOP = new Set(
  "the a an to in on of for and or is are what how do does did me my i you your this that with from please can could should would about tell get show it up be have has all any across needs need".split(" "),
);

/** Lightweight lexical retrieval used for the extractive preview and to pick demo context for the AI. */
export function retrieve(docs: JeffDoc[], question: string, scope = "all", limit = 6): JeffDoc[] {
  const q = question.toLowerCase();
  let terms: string[] = [...(q.match(/[a-z0-9]+/g) ?? [])];
  terms = terms.filter((t) => !STOP.has(t) && t.length > 1);
  if (/attention|priorit|urgent/.test(q)) terms.push("deadline", "blocked", "follow-up", "pending");
  if (/meeting|prepare|week|coming/.test(q)) terms.push("meeting");
  if (/idea|inspir/.test(q)) terms.push("ideas");
  if (/lead|follow.?up|client/.test(q)) terms.push("clients", "sales", "follow-up");
  const pool = docs.filter((d) => scope === "all" || d.source === scope);
  return pool
    .map((d) => {
      let score = 0;
      const text = d.content.toLowerCase();
      const title = d.title.toLowerCase();
      const tags = (d.tags ?? []).join(" ");
      for (const t of terms) {
        score += title.includes(t) ? 5 : 0;
        score += text.includes(t) ? 2 : 0;
        score += tags.includes(t) ? 3 : 0;
      }
      if (/meeting|prepare|coming up/.test(q) && d.source === "calendar") score += 7;
      if (/atlas/.test(q) && !`${text} ${title}`.includes("atlas")) score = 0;
      if (/northstar/.test(q) && !`${text} ${title}`.includes("northstar")) score = 0;
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.d.updated.localeCompare(a.d.updated))
    .slice(0, limit)
    .map((x) => x.d);
}

export function linksFor(items: JeffDoc[]): [string, string, string[]][] {
  const edges: [string, string, string[]][] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const shared = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t));
      if (shared.length >= 2) edges.push([a.id, b.id, shared]);
    }
  return edges;
}

export function shortDate(d: string) {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "Just added" : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function extractiveAnswer(question: string, refs: JeffDoc[], mode: "demo" | "live") {
  if (!refs.length)
    return `I did not find enough matching context in ${mode === "demo" ? "the sample workspace" : "your synced memories"} to answer that.\n\nTry a project name, a person, or a phrase from a document. You can also connect another source or add a note.\n\nThis is a search-based preview, not a live AI response.`;
  return (
    `${mode === "demo" ? "From the sample workspace" : "Here is the context I found"}:\n\n` +
    refs.map((d, i) => `${d.title} [${i + 1}]\n${d.content.length > 380 ? d.content.slice(0, 377) + "..." : d.content}`).join("\n\n") +
    "\n\nOpen a source below to see the original context."
  );
}
