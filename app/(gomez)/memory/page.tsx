import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { listMemories, listRules } from "@/lib/gomez/rules/store";
import { detectConflicts } from "@/lib/gomez/rules/conflicts";
import { presentRule } from "@/lib/gomez/rules/present";
import { ensureSystemRules } from "@/lib/gomez/rules/apply";
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
