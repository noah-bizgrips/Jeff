import { DEFAULT_CADENCE, type Cadence, type ObligationRow } from "./types";

/** Effective reminder cadence: tracking-mode defaults overlaid with the obligation's own settings (pure). */
export function effectiveCadence(o: Pick<ObligationRow, "cadence" | "tracking_mode">): Cadence {
  const base: Cadence = { ...DEFAULT_CADENCE };
  if (o.tracking_mode === "important") base.follow_up_hours = 4;
  if (o.tracking_mode === "critical") {
    base.follow_up_hours = 3;
    base.daily_cap = 4;
    base.business_hours_only = false;
  }
  const own = Object.fromEntries(Object.entries(o.cadence ?? {}).filter(([, v]) => v !== undefined && v !== null)) as Partial<Cadence>;
  return { ...base, ...own };
}
