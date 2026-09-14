import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { listAlerts } from "@/lib/jeff/alerts/store";
import { listAlertGroups } from "@/lib/jeff/grouping/store";
import { AlertsView, type AlertGroupItem, type AlertItem } from "@/components/alerts/AlertsView";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const [alerts, groups] = await Promise.all([listAlerts(session.userId, { limit: 200 }).catch(() => []), listAlertGroups(session.userId, { limit: 100 }).catch(() => [])]);
  return <AlertsView initial={alerts as unknown as AlertItem[]} groups={groups as unknown as AlertGroupItem[]} />;
}
