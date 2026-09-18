import { inQuietHours, localTime, type OwnerSettings } from "@/lib/gomez/settings";
import { BLIND_SPOT_EMOJI } from "@/lib/gomez/push/emoji";

/**
 * Pure push decision for blind spots: at most ONE batch per owner-local day,
 * only when the toggle is on and outside quiet hours.
 */
export interface BlindSpotPushInput {
  pendingTitles: string[];
  lastBatchAt: string | null;
  settings: Pick<OwnerSettings, "push_blind_spots" | "timezone" | "quiet_hours_start" | "quiet_hours_end">;
  now: Date;
}

export function shouldPushBlindSpotBatch(input: BlindSpotPushInput): boolean {
  if (!input.settings.push_blind_spots) return false;
  if (!input.pendingTitles.length) return false;
  if (inQuietHours(input.now, input.settings)) return false;
  if (input.lastBatchAt) {
    const last = new Date(input.lastBatchAt);
    if (!Number.isNaN(last.getTime()) && localTime(last, input.settings.timezone).date === localTime(input.now, input.settings.timezone).date) return false;
  }
  return true;
}

export function blindSpotPushPayload(titles: string[]): { title: string; body: string; url: string; tag: string } {
  const first = titles[0] ?? "";
  const more = titles.length - 1;
  return {
    title: `${BLIND_SPOT_EMOJI} Gomez noticed something you might be missing`,
    body: `${first}${more > 0 ? ` (+${more} more)` : ""}`.slice(0, 160),
    url: "/insights?view=blind",
    tag: "blindspots:daily",
  };
}
