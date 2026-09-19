import { describe, expect, it, vi, beforeEach } from "vitest";
import { shouldPushAlert, shouldPushBriefing, type PushableAlert } from "@/lib/jeff/push/decide";
import { DEFAULT_SETTINGS } from "@/lib/jeff/settings";
import { classifyRoute } from "@/lib/auth/routes";
import { alertEmoji, BRIEFING_EMOJI } from "@/lib/jeff/push/emoji";

/* ------------------------------------------------------------------ */
/* Decision matrix (pure)                                              */
/* ------------------------------------------------------------------ */

const denver = { timezone: "America/Denver", quiet_hours_start: "21:00", quiet_hours_end: "07:00", push_goal_alerts: true, push_opportunity_alerts: true };
// 2026-09-12 14:00 Denver (MDT, UTC-6) = 20:00Z → outside quiet hours
const DAY = new Date("2026-09-12T20:00:00Z");
// 2026-09-12 23:00 Denver = 05:00Z next day → inside quiet hours
const NIGHT = new Date("2026-09-13T05:00:00Z");

function alert(over: Partial<PushableAlert> = {}): PushableAlert {
  return { id: "a1", status: "open", importance: "important", deferred_until: null, pushed_at: null, pushed_importance: null, ...over };
}

describe("shouldPushAlert", () => {
  it("urgent alerts always push, even in quiet hours or with push_alerts off", () => {
    expect(shouldPushAlert(alert({ importance: "urgent" }), { push_alerts: false, ...denver }, NIGHT)).toBe(true);
  });
  it("important alerts push outside quiet hours when enabled", () => {
    expect(shouldPushAlert(alert(), { push_alerts: true, ...denver }, DAY)).toBe(true);
  });
  it("important alerts are held during quiet hours and when the toggle is off", () => {
    expect(shouldPushAlert(alert(), { push_alerts: true, ...denver }, NIGHT)).toBe(false);
    expect(shouldPushAlert(alert(), { push_alerts: false, ...denver }, DAY)).toBe(false);
  });
  it("goal alerts push at briefing importance when the goal toggle is on, not when off", () => {
    const goal = alert({ kind: "goal", category: "goal_trajectory", importance: "briefing" });
    expect(shouldPushAlert(goal, { push_alerts: false, ...denver }, DAY)).toBe(true);
    expect(shouldPushAlert(goal, { push_alerts: true, ...denver, push_goal_alerts: false }, DAY)).toBe(false);
    expect(shouldPushAlert(goal, { push_alerts: true, ...denver }, NIGHT)).toBe(false);
  });
  it("opportunity findings push at briefing importance with their own toggle; other findings need important+", () => {
    const opp = alert({ kind: "finding", category: "lead_followup_gap", importance: "briefing" });
    expect(shouldPushAlert(opp, { push_alerts: true, ...denver }, DAY)).toBe(true);
    expect(shouldPushAlert(opp, { push_alerts: true, ...denver, push_opportunity_alerts: false }, DAY)).toBe(false);
    const fin = alert({ kind: "finding", category: "failed_payment", importance: "briefing" });
    expect(shouldPushAlert(fin, { push_alerts: true, ...denver }, DAY)).toBe(false);
  });
  it("deferred alerts wait for their deferral to pass", () => {
    const later = new Date(DAY.getTime() + 3_600_000).toISOString();
    expect(shouldPushAlert(alert({ deferred_until: later }), { push_alerts: true, ...denver }, DAY)).toBe(false);
    expect(shouldPushAlert(alert({ deferred_until: later }), { push_alerts: true, ...denver }, new Date(DAY.getTime() + 7_200_000))).toBe(true);
  });
  it("informational and briefing-level alerts never push", () => {
    expect(shouldPushAlert(alert({ importance: "informational" }), { push_alerts: true, ...denver }, DAY)).toBe(false);
    expect(shouldPushAlert(alert({ importance: "briefing" }), { push_alerts: true, ...denver }, DAY)).toBe(false);
  });
  it("pushes once per importance level; escalation re-pushes, repeats do not", () => {
    const pushed = alert({ pushed_at: DAY.toISOString(), pushed_importance: "important" });
    expect(shouldPushAlert(pushed, { push_alerts: true, ...denver }, DAY)).toBe(false);
    expect(shouldPushAlert({ ...pushed, importance: "urgent" }, { push_alerts: true, ...denver }, DAY)).toBe(true);
  });
  it("only open alerts push (snoozed/dismissed/resolved never)", () => {
    for (const status of ["snoozed", "dismissed", "resolved", "acknowledged"]) {
      expect(shouldPushAlert(alert({ status, importance: "urgent" }), { push_alerts: true, ...denver }, DAY)).toBe(false);
    }
  });
});

describe("shouldPushBriefing", () => {
  it("respects the toggle", () => {
    expect(shouldPushBriefing({ push_briefings: true })).toBe(true);
    expect(shouldPushBriefing({ push_briefings: false })).toBe(false);
    expect(DEFAULT_SETTINGS.push_briefings).toBe(true);
    expect(DEFAULT_SETTINGS.push_alerts).toBe(true);
  });
});

describe("service worker + manifest are public", () => {
  it("never redirects sw.js, the manifest, or icons to /login", () => {
    expect(classifyRoute("/sw.js")).toBe("public");
    expect(classifyRoute("/manifest.webmanifest")).toBe("public");
    expect(classifyRoute("/icons/icon-192.png")).toBe("public");
  });
});

/* ------------------------------------------------------------------ */
/* sendPush with a mocked web-push + DB                                */
/* ------------------------------------------------------------------ */

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: (...a: unknown[]) => sendNotification(...a) } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const updates: { id: string; patch: Record<string, unknown> }[] = [];
const subs = [
  { id: "s1", endpoint: "https://push.example/1", p256dh: "k1", auth: "a1" },
  { id: "s2", endpoint: "https://push.example/2", p256dh: "k2", auth: "a2" },
];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const self = () => q;
      q.select = self;
      q.is = self;
      q.eq = (col: string, v: string) => {
        if (col === "endpoint") return { then: (r: (x: unknown) => void) => r({ data: subs.filter((s) => s.endpoint === v) }) };
        if (col === "id" && q._patch) updates.push({ id: v, patch: q._patch as Record<string, unknown> });
        return q;
      };
      q.update = (patch: Record<string, unknown>) => {
        q._patch = patch;
        return q;
      };
      q.then = (resolve: (x: unknown) => void) => resolve({ data: table === "push_subscriptions" ? subs : [], error: null });
      return q;
    },
  }),
}));

describe("sendPush", () => {
  beforeEach(() => {
    updates.length = 0;
    sendNotification.mockReset();
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "BPublicTestKey";
    process.env.VAPID_PRIVATE_KEY = "PrivateTestKey";
  });
  it("delivers to every enabled device and disables 410/404 endpoints", async () => {
    sendNotification.mockImplementationOnce(async () => ({ statusCode: 201 })).mockImplementationOnce(async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    const { sendPush } = await import("@/lib/jeff/push/send");
    const res = await sendPush("owner", { title: "T", body: "B".repeat(300), url: "/alerts", tag: "t" });
    expect(res).toEqual({ attempted: 2, delivered: 1, disabled: 1, failed: 0 });
    const disabled = updates.find((u) => u.id === "s2");
    expect(disabled?.patch.disabled_at).toBeTruthy();
    // body is trimmed to 120 chars and keys are passed through, never logged
    const payload = JSON.parse(sendNotification.mock.calls[0]![1] as string) as { body: string };
    expect(payload.body.length).toBeLessThanOrEqual(120);
  });
  it("is a no-op when VAPID keys are missing", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const { sendPush } = await import("@/lib/jeff/push/send");
    expect(await sendPush("owner", { title: "T", body: "B", url: "/", tag: "t" })).toEqual({ attempted: 0, delivered: 0, disabled: 0, failed: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("notification emoji", () => {
  it("assigns a distinct emoji per alert type", () => {
    expect(alertEmoji({ kind: "goal", category: "goal_trajectory", importance: "briefing" })).toBe("🎯");
    expect(alertEmoji({ kind: "finding", category: "failed_payment", importance: "important" })).toBe("💳");
    expect(alertEmoji({ kind: "finding", category: "lead_followup_gap", importance: "briefing" })).toBe("🧲");
    expect(alertEmoji({ kind: "finding", category: "automation_opportunity", importance: "briefing" })).toBe("💡");
    expect(alertEmoji({ kind: "commitment", category: null, importance: "important" })).toBe("🤝");
    expect(alertEmoji({ kind: "finding", category: "something_new", importance: "urgent" })).toBe("🚨");
    expect(BRIEFING_EMOJI.daily).toBe("☀️");
  });
});
