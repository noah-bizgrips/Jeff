import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { latestSnapshot, listGoalMetrics, listGoals } from "@/lib/gomez/goals/store";
import { GoalsView, type GoalListItem } from "@/components/goals/GoalsView";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const goals = await listGoals(session.userId).catch(() => []);
  const items: GoalListItem[] = await Promise.all(
    goals.map(async (goal) => {
      const [snapshot, metrics] = await Promise.all([latestSnapshot(goal.id).catch(() => null), listGoalMetrics(goal.id).catch(() => [])]);
      return { goal, snapshot, metrics };
    }),
  );
  return <GoalsView initial={items} />;
}
