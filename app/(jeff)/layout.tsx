import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { effectiveMode } from "@/lib/mode";
import { hasEnv } from "@/lib/env";
import { dailyBudgetUsd } from "@/lib/jeff/pricing";
import { listConnections } from "@/lib/integrations/store";
import { loadCounts, loadLiveDocs, loadNotes, loadSaved } from "@/lib/jeff/server-data";
import { DEMO_MISSIONS } from "@/lib/jeff/demo-data";
import { JeffProvider, type JeffInitial } from "@/components/jeff/store";
import { AppShell } from "@/components/jeff/AppShell";
import { PushManager } from "@/components/jeff/PushManager";
import { surfacedAlerts } from "@/lib/jeff/alerts/store";
import { getSettings } from "@/lib/jeff/settings-store";
import { atLeast } from "@/lib/jeff/alerts/importance";
import { getBrainState } from "@/lib/jeff/brain/load";
import { EMPTY_BRAIN_STATE } from "@/lib/jeff/brain/state";

async function countSurfacedAlerts(ownerId: string): Promise<number> {
  const [alerts, settings] = await Promise.all([surfacedAlerts(ownerId, new Date(), 50), getSettings(ownerId).catch(() => null)]);
  const min = settings?.alert_min_importance ?? "important";
  return alerts.filter((a) => a.status === "open" && atLeast(a.importance, min)).length;
}

export const dynamic = "force-dynamic";

/**
 * Protected workspace layout. proxy.ts already gates these routes; this is
 * the second, independent check so workspace HTML is never rendered for
 * anyone but the aal2 owner.
 */
export default async function JeffLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status === "anonymous") redirect("/login");
  if (session.status === "unauthorized") redirect("/unauthorized");
  if (session.aal !== "aal2") redirect("/mfa");

  const mode = await effectiveMode();
  const [connections, liveDocs, notes, saved, counts, alertCount, brain] = await Promise.all([
    listConnections(session.userId).catch(() => []),
    mode === "live" ? loadLiveDocs(supabase) : Promise.resolve([]),
    mode === "live" ? loadNotes(supabase) : Promise.resolve([]),
    mode === "live" ? loadSaved(supabase) : Promise.resolve([]),
    loadCounts(supabase),
    mode === "live" ? countSurfacedAlerts(session.userId) : Promise.resolve(0),
    mode === "live" ? getBrainState(session.userId) : Promise.resolve(EMPTY_BRAIN_STATE),
  ]);

  const initial: JeffInitial = {
    mode,
    aiEnabled: hasEnv("ANTHROPIC_API_KEY"),
    aiBudgetUsd: dailyBudgetUsd(),
    ownerEmail: session.email,
    aal: session.aal,
    connections,
    liveDocs,
    notes,
    saved,
    missionCount: mode === "demo" ? DEMO_MISSIONS.length + counts.missions : counts.missions,
    approvalCount: mode === "demo" ? DEMO_MISSIONS.filter((m) => m.status === "review").length + counts.approvals : counts.approvals,
    alertCount,
    brain,
  };

  return (
    <JeffProvider initial={initial}>
      <PushManager />
      <AppShell>{children}</AppShell>
    </JeffProvider>
  );
}
