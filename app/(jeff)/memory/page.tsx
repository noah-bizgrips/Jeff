import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { listMemories, listRules } from "@/lib/jeff/rules/store";
import { detectConflicts } from "@/lib/jeff/rules/conflicts";
import { presentRule } from "@/lib/jeff/rules/present";
import { ensureSystemRules } from "@/lib/jeff/rules/apply";
import { MemoryRulesView } from "@/components/memory/MemoryRulesView";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const [memories, rulesRaw] = await Promise.all([listMemories(session.userId).catch(() => []), listRules(session.userId).catch(() => [])]);
  const rules = await ensureSystemRules(session.userId, rulesRaw).catch(() => rulesRaw);
  return <MemoryRulesView memories={memories} rules={rules.map(presentRule)} conflicts={detectConflicts(rules)} />;
}
