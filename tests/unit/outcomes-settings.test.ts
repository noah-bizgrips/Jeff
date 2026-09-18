import { describe, expect, it } from "vitest";
import { baselineWindow, computeOutcome, countInWindow, postWindow, postWindowElapsed, valueAt } from "@/lib/gomez/outcomes";
import { OwnerSettingsSchema, SettingsPatchSchema, withDefaults } from "@/lib/gomez/settings";

describe("outcome measurement", () => {
  it("computes delta, direction and cautious wording", () => {
    const worse = computeOutcome(10, 14, false); // lower is better, went up
    expect(worse.direction).toBe("worsened");
    expect(worse.delta).toBe(4);
    expect(worse.delta_pct).toBe(40);
    const better = computeOutcome(10, 6, false, ["Other mission"]);
    expect(better.direction).toBe("improved");
    expect(better.limitations).toContain("causal attribution is not established");
    expect(better.limitations).toContain("Other mission");
    expect(computeOutcome(100, 103, true).direction).toBe("unchanged");
    expect(computeOutcome(null, 5, true).direction).toBe("unknown");
    expect(computeOutcome(0, 0, true).direction).toBe("unchanged");
  });
  it("windows and helpers", () => {
    const at = new Date("2026-09-01T00:00:00.000Z");
    expect(baselineWindow(at).start).toBe("2026-08-18T00:00:00.000Z");
    expect(postWindow(at).end).toBe("2026-09-15T00:00:00.000Z");
    expect(postWindowElapsed(at, new Date("2026-09-14T00:00:00.000Z"))).toBe(false);
    expect(postWindowElapsed(at, new Date("2026-09-15T00:00:00.000Z"))).toBe(true);
    expect(countInWindow([{ created_at: "2026-08-20T00:00:00.000Z" }, { created_at: "2026-09-02T00:00:00.000Z" }], baselineWindow(at))).toBe(1);
    expect(valueAt([{ taken_at: "2026-08-30T00:00:00.000Z", value: 4 }, { taken_at: "2026-09-02T00:00:00.000Z", value: 6 }], at)).toBe(4);
  });
});

describe("settings", () => {
  it("defaults are valid and only Tier-1 keys are accepted", () => {
    expect(OwnerSettingsSchema.safeParse(withDefaults(null)).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ daily_brief_time: "08:00" }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ mfa_required: false }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ rls_enabled: false }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ daily_brief_time: "8am" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ timezone: "Mars/Olympus" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ timezone: "America/Denver", brief_max_items: 5 }).success).toBe(true);
  });
});
