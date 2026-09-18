import { describe, expect, it } from "vitest";
import { attentionCountOf, computeBrainState, liteOf } from "@/lib/gomez/brain/state";
import { BRAIN_COLORS, BRAIN_POLICY, pulsePeriodMs } from "@/lib/gomez/brain/policy";
import { sourceForProvider, sourcesForJob, sourcesForProvider, sourcesForScanStage, sourcesForTools } from "@/lib/gomez/brain/sources";
import { FIXTURE_NOW, SCENARIOS, alert, base, conn, finding, goal, obligation, run } from "@/lib/gomez/brain/fixtures";

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;

describe("brain state — attention (§36)", () => {
  it("counts exactly the reasons it lists: 3 things need attention", () => {
    const s = computeBrainState(scenario("attention").input);
    expect(s.state).toBe("attention");
    expect(s.urgency).toBe("important");
    expect(s.primaryStatus).toBe("3 things need attention");
    expect(s.reasonCount).toBe(3);
    expect(attentionCountOf(s.reasons)).toBe(3);
    expect(s.reasons.attention).toHaveLength(2);
    expect(s.reasons.followThrough).toHaveLength(1);
    expect(s.secondaryStatus).toBe("1 business · 1 financial · 1 follow-through");
  });

  it("maps affected sources from evidence providers with warning tone", () => {
    const s = computeBrainState(scenario("attention").input);
    const stripe = s.affectedSources.find((x) => x.source === "stripe");
    const lc = s.affectedSources.find((x) => x.source === "leadconnector");
    expect(stripe?.tone).toBe("warning");
    expect(lc?.tone).toBe("warning");
    expect(s.affectedSources.find((x) => x.source === "github")).toBeUndefined();
  });

  it("urgent alert → urgent pulse, danger tone, sharper period", () => {
    const s = computeBrainState(scenario("urgent").input);
    expect(s.state).toBe("attention");
    expect(s.urgency).toBe("urgent");
    expect(s.affectedSources.find((x) => x.source === "stripe")?.tone).toBe("danger");
    expect(pulsePeriodMs(s.state, s.urgency, false)).toBe(BRAIN_POLICY.pulseMs.urgent);
    expect(pulsePeriodMs("attention", "important", false)).toBe(BRAIN_POLICY.pulseMs.attention);
  });

  it("goal already covered by an alert is not double counted", () => {
    const s = computeBrainState(base({ alerts: [alert("a1", "important", "Goal at risk", { kind: "goal", ref_id: "g1", evidence: [{ provider: "stripe" }] })], goals: [goal("g1", "MRR", "at_risk")] }));
    expect(s.reasons.attention).toHaveLength(1);
    expect(s.reasonCount).toBe(1);
  });
});

describe("brain state — noise filter (§28, §29, §36)", () => {
  it("suppressed_by_rule / dismissed / resolved findings and non-open alerts contribute nothing", () => {
    const s = computeBrainState(scenario("noise").input);
    expect(s.state).toBe("watching");
    expect(s.reasonCount).toBe(0);
    expect(s.reasons.attention).toHaveLength(0);
    expect(s.reasons.opportunities).toHaveLength(0);
    expect(s.affectedSources.find((x) => x.source === "github")).toBeUndefined();
    expect(s.primaryStatus).toBe("Watching");
  });

  it("acknowledged, snoozed, dismissed and resolved alerts are excluded", () => {
    const s = computeBrainState(
      base({
        alerts: [
          alert("a", "urgent", "Acked", { status: "acknowledged" }),
          alert("b", "urgent", "Snoozed", { status: "snoozed" }),
          alert("c", "urgent", "Dismissed", { status: "dismissed" }),
          alert("d", "urgent", "Resolved", { status: "resolved" }),
          alert("e", "informational", "FYI"),
          alert("f", "briefing", "Digest"),
        ],
      }),
    );
    expect(s.reasons.attention).toHaveLength(0);
    expect(s.state).toBe("watching");
  });
});

describe("brain state — opportunity (§37)", () => {
  it("opportunity findings light the opportunity state without attention pressure", () => {
    const s = computeBrainState(scenario("opportunity").input);
    expect(s.state).toBe("opportunity");
    expect(s.attentionLevel).toBe(0);
    expect(s.opportunityLevel).toBeGreaterThan(0);
    expect(s.primaryStatus).toBe("2 opportunities found");
    expect(s.reasonCount).toBe(2);
    expect(s.affectedSources.find((x) => x.source === "leadconnector")?.tone).toBe("opportunity");
  });

  it("low-confidence findings are not opportunities", () => {
    const s = computeBrainState(base({ findings: [finding("f", "blind_spot", "Maybe", { metrics: { theme: "opportunity" }, confidence: 0.2 })] }));
    expect(s.reasons.opportunities).toHaveLength(0);
    expect(s.state).toBe("watching");
  });
});

describe("brain state — system health (§38)", () => {
  it("broken and stale sources degrade the brain without business pressure", () => {
    const s = computeBrainState(scenario("degraded").input);
    expect(s.state).toBe("degraded");
    expect(s.attentionLevel).toBe(0);
    expect(s.systemHealth).toBeLessThanOrEqual(BRAIN_POLICY.degradedHealthAt);
    expect(s.reasons.system.map((r) => r.kind).sort()).toEqual(["connection", "connection", "job"]);
    const gmail = s.affectedSources.find((x) => x.source === "gmail");
    expect(gmail?.tone).toBe("warning");
    expect(gmail?.dashed).toBe(true);
    expect(s.affectedSources.find((x) => x.source === "slack")?.tone).toBe("stale");
    expect(s.primaryStatus).toMatch(/sources? needs? attention/);
  });

  it("a stale source stays visible under an attention state (§8)", () => {
    const s = computeBrainState(scenario("mixed").input);
    expect(s.state).toBe("attention");
    expect(s.affectedSources.find((x) => x.source === "slack")?.tone).toBe("stale");
    expect(s.affectedSources.find((x) => x.source === "stripe")?.tone).toBe("warning");
    expect(s.affectedSources.find((x) => x.source === "leadconnector")?.tone).toBe("opportunity");
  });
});

describe("brain state — investigating (§39)", () => {
  it("a running job puts the brain into investigating with its declared sources active", () => {
    const s = computeBrainState(scenario("investigating").input);
    expect(s.state).toBe("investigating");
    expect(s.activityLevel).toBe(1);
    expect(s.activeSources.sort()).toEqual(["leadconnector", "portal"]);
    expect(s.primaryStatus).toBe("Investigating…");
    expect(pulsePeriodMs(s.state, s.urgency, false)).toBe(BRAIN_POLICY.pulseMs.investigating);
  });

  it("transitions back once the run finishes", () => {
    const before = computeBrainState(base({ jobRuns: [run("j", "Job", "running")] }));
    const after = computeBrainState(base({ jobRuns: [run("j", "Job", "succeeded")] }));
    expect(before.state).toBe("investigating");
    expect(after.state).toBe("watching");
    expect(after.activeSources).toEqual([]);
  });
});

describe("brain state — zero state (§35)", () => {
  it("no connections → Quiet with the slow pulse", () => {
    const s = computeBrainState(scenario("quiet").input);
    expect(s.state).toBe("watching");
    expect(s.primaryStatus).toBe("Quiet");
    expect(s.secondaryStatus).toBe("No sources connected yet");
    expect(pulsePeriodMs(s.state, s.urgency, true)).toBe(BRAIN_POLICY.pulseMs.quiet);
  });

  it("healthy connections with nothing open → Watching", () => {
    const s = computeBrainState(scenario("watching").input);
    expect(s.primaryStatus).toBe("Watching");
    expect(s.systemHealth).toBe(1);
    expect(s.affectedSources).toEqual([]);
    expect(pulsePeriodMs(s.state, s.urgency, false)).toBe(BRAIN_POLICY.pulseMs.watching);
  });
});

describe("brain state — obligation weighting (§30)", () => {
  it("a trivial personal errand never counts; a client-linked money item does", () => {
    const s = computeBrainState(
      base({
        obligations: [
          obligation("triv", "Buy milk", { scope: "personal", priority: "low" }),
          obligation("cli", "Chase the Northwind invoice", { priority: "normal", related_client_id: "c1", has_money: true }),
          obligation("wait", "Waiting on Sam's numbers", { bucket: "waiting_on_other", priority: "high", related_goal_id: "g1", due_at: null }),
        ],
      }),
    );
    const ids = s.reasons.followThrough.map((r) => r.id);
    expect(ids).not.toContain("obligation:triv");
    expect(ids).toContain("obligation:cli");
    expect(ids).toContain("obligation:wait");
    // Only the overdue one counts toward "things need attention".
    expect(attentionCountOf(s.reasons)).toBe(1);
    expect(s.primaryStatus).toBe("1 thing needs attention");
  });

  it("done and snoozed obligations are ignored", () => {
    const s = computeBrainState(base({ obligations: [obligation("d", "Done", { bucket: "done", priority: "critical" }), obligation("s", "Snoozed", { bucket: "snoozed", priority: "critical" })] }));
    expect(s.reasons.followThrough).toHaveLength(0);
  });
});

describe("brain state — precedence (§9, §40)", () => {
  it("investigating > urgent > degraded > important > opportunity > watching", () => {
    const urgent = alert("u", "urgent", "Urgent", { evidence: [{ provider: "stripe" }] });
    const important = alert("i", "important", "Important", { evidence: [{ provider: "stripe" }] });
    const opp = finding("o", "blind_spot", "Opp", { metrics: { theme: "opportunity" } });
    const broken = [conn("google", { status: "error", freshness_level: "error", freshness_text: "Sync error" }), conn("stripe"), conn("slack", { status: "reconnect_required", freshness_level: "error", freshness_text: "Reconnect" })];

    expect(computeBrainState(base({ alerts: [urgent, important], findings: [opp], connections: broken, jobRuns: [run("j", "Job", "running")] })).state).toBe("investigating");
    expect(computeBrainState(base({ alerts: [urgent, important], findings: [opp], connections: broken })).state).toBe("attention");
    expect(computeBrainState(base({ alerts: [urgent], findings: [opp], connections: broken })).urgency).toBe("urgent");
    expect(computeBrainState(base({ alerts: [important], findings: [opp], connections: broken })).state).toBe("degraded");
    expect(computeBrainState(base({ alerts: [important], findings: [opp] })).state).toBe("attention");
    expect(computeBrainState(base({ findings: [opp] })).state).toBe("opportunity");
    expect(computeBrainState(base()).state).toBe("watching");
  });

  it("status text and counts always agree with the listed reasons (§15)", () => {
    for (const sc of SCENARIOS) {
      const s = computeBrainState(sc.input);
      if (s.state === "attention") {
        expect(s.reasonCount).toBe(attentionCountOf(s.reasons));
        expect(s.primaryStatus.startsWith(`${s.reasonCount} thing`)).toBe(true);
      } else if (s.state === "opportunity") {
        expect(s.reasonCount).toBe(s.reasons.opportunities.length);
      } else if (s.state === "degraded") {
        expect(s.reasonCount).toBe(s.reasons.system.length);
      }
      const lite = liteOf(s);
      expect(lite.reasonIds.length).toBe(s.reasons.attention.length + s.reasons.opportunities.length + s.reasons.followThrough.length + s.reasons.system.length);
      expect(s.computedAt).toBe(FIXTURE_NOW.toISOString());
    }
  });
});

describe("brain sources — deterministic mapping (§16, §17, §41)", () => {
  it("providers map to visual sources", () => {
    expect(sourcesForProvider("google").sort()).toEqual(["calendar", "drive", "gmail"]);
    expect(sourcesForProvider("google", ["gmail"])).toEqual(["gmail"]);
    expect(sourcesForProvider("highlevel")).toEqual(["leadconnector"]);
    expect(sourcesForProvider("meta", ["ads"])).toEqual(["metaads"]);
    expect(sourceForProvider("google", "calendar")).toBe("calendar");
    expect(sourceForProvider("stripe")).toBe("stripe");
    expect(sourcesForProvider("unknown")).toEqual([]);
  });

  it("toolsUsed → only the sources actually read, only when connected", () => {
    const connected = ["stripe", "plaid", "slack", "leadconnector", "gmail"];
    expect(sourcesForTools(["get_financial_summary"], connected).sort()).toEqual(["plaid", "stripe"]);
    expect(sourcesForTools(["search_slack", "get_crm_pipeline"], connected).sort()).toEqual(["leadconnector", "slack"]);
    expect(sourcesForTools(["get_calendar_context"], connected)).toEqual([]); // calendar not connected
    expect(sourcesForTools(["remember", "list_alerts", "apply_rule"], connected)).toEqual([]); // Gomez's own tables
    expect(sourcesForTools(["search_sources"], connected).sort()).toEqual([...connected].sort());
    expect(sourcesForTools([], connected)).toEqual([]);
  });

  it("scan stages → sources being examined; unknown stages examine nothing", () => {
    const connected = ["stripe", "plaid", "gmail", "leadconnector"];
    expect(sourcesForScanStage("financial", connected).sort()).toEqual(["plaid", "stripe"]);
    expect(sourcesForScanStage("commitments", connected)).toEqual(["gmail"]);
    expect(sourcesForScanStage("reviewing_goals", connected, ["stripe", "calendar"])).toEqual(["stripe"]);
    expect(sourcesForScanStage("preparing", connected)).toEqual([]);
    expect(sourcesForScanStage("ranking", connected)).toEqual(connected);
  });

  it("job declared sources → connected visual sources", () => {
    expect(sourcesForJob(["stripe", "highlevel", "google"], ["stripe", "leadconnector", "gmail"]).sort()).toEqual(["gmail", "leadconnector", "stripe"]);
    expect(sourcesForJob(["notion"], ["stripe"])).toEqual([]);
  });
});

describe("brain policy (§27)", () => {
  it("thresholds are ordered and colours match the Gomez Black theme", () => {
    expect(BRAIN_POLICY.attentionImportantAt).toBeLessThan(BRAIN_POLICY.attentionUrgentAt);
    expect(BRAIN_POLICY.pulseMs.quiet).toBeGreaterThan(BRAIN_POLICY.pulseMs.watching!);
    expect(BRAIN_POLICY.pulseMs.watching).toBeGreaterThan(BRAIN_POLICY.pulseMs.attention!);
    expect(BRAIN_POLICY.pulseMs.attention).toBeGreaterThan(BRAIN_POLICY.pulseMs.urgent!);
    expect(BRAIN_POLICY.pulseMs.urgent).toBeGreaterThan(BRAIN_POLICY.pulseMs.investigating!);
    expect(BRAIN_POLICY.colorLerpMs).toBeGreaterThanOrEqual(300);
    expect(BRAIN_POLICY.haloLerpMs).toBeLessThanOrEqual(800);
    expect(BRAIN_POLICY.retrievalFlashMs).toBeLessThanOrEqual(1500);
    expect(BRAIN_POLICY.refreshMinGapMs).toBeGreaterThanOrEqual(10_000);
    expect(BRAIN_COLORS.danger.toUpperCase()).toBe("#E57777");
    expect(BRAIN_COLORS.warning.toUpperCase()).toBe("#E4B669");
    expect(BRAIN_COLORS.active.toUpperCase()).toBe("#78BEFF");
    expect(BRAIN_COLORS.gomez.toUpperCase()).toBe("#4DA3FF");
  });
});
