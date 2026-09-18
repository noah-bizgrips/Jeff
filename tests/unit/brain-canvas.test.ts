import { describe, expect, it } from "vitest";
import { centerToneFor, toneTargets } from "@/components/brain/BrainCanvas";
import { resolveMotion } from "@/lib/gomez/brain/policy";
import { computeBrainState, liteOf } from "@/lib/gomez/brain/state";
import { SCENARIOS } from "@/lib/gomez/brain/fixtures";

const lite = (id: string) => liteOf(computeBrainState(SCENARIOS.find((s) => s.id === id)!.input));

describe("brain canvas — tone resolution (§8, §16, §25)", () => {
  it("activity (actually-read sources) outranks state tones; stale keeps its dashed path", () => {
    const t = toneTargets(lite("mixed"), { kind: "ask", sources: ["stripe"] });
    expect(t.get("stripe")?.tone).toBe("active");
    expect(t.get("leadconnector")?.tone).toBe("opportunity");
    expect(t.get("slack")?.tone).toBe("stale");
    expect(t.get("slack")?.dashed).toBe(true);
    expect(t.has("github")).toBe(false);
  });

  it("no state and no activity → nothing is toned", () => {
    expect(toneTargets(null, null).size).toBe(0);
    expect(toneTargets(lite("watching"), { kind: null, sources: [] }).size).toBe(0);
  });

  it("running jobs mark their declared sources active", () => {
    const t = toneTargets(lite("investigating"), null);
    expect(t.get("leadconnector")?.tone).toBe("active");
    expect(t.get("portal")?.tone).toBe("active");
  });

  it("centre colour follows the ambient state and investigation", () => {
    expect(centerToneFor(lite("urgent"), false).rgb).toEqual([229, 119, 119]);
    expect(centerToneFor(lite("attention"), false).rgb).toEqual([228, 182, 105]);
    expect(centerToneFor(lite("opportunity"), false).rgb).toEqual([103, 199, 217]);
    expect(centerToneFor(lite("watching"), false).rgb).toEqual([77, 163, 255]);
    expect(centerToneFor(lite("urgent"), true).rgb).toEqual([120, 190, 255]);
    expect(centerToneFor(null, false).intensity).toBeLessThan(centerToneFor(lite("urgent"), false).intensity);
  });
});

describe("reduced motion helper (§26)", () => {
  it("honours the OS preference unless the owner pressed play/pause", () => {
    expect(resolveMotion(true, null)).toBe(false);
    expect(resolveMotion(false, null)).toBe(true);
    expect(resolveMotion(true, true)).toBe(true);
    expect(resolveMotion(false, false)).toBe(false);
  });
});
