import { describe, expect, it } from "vitest";
import { describeSchedule, dueJobs, nextCustom, nextRunAt, parseExpression, zonedToUtc } from "@/lib/jeff/jobs/schedule";
import { localTime } from "@/lib/jeff/settings";

const TZ = "America/Denver";
const job = (schedule_type: Parameters<typeof nextRunAt>[0]["schedule_type"], schedule_expression: string | null = null, status = "active") => ({ schedule_type, schedule_expression, status: status as "active" });

describe("parseExpression", () => {
  it("reads weekday, day-of-month and time with defaults", () => {
    expect(parseExpression("weekly", "fri 07:05")).toEqual({ time: "07:05", weekday: 5, dayOfMonth: null });
    expect(parseExpression("weekly", null)).toEqual({ time: "07:05", weekday: 1, dayOfMonth: null });
    expect(parseExpression("monthly", "15 6:30")).toEqual({ time: "06:30", weekday: null, dayOfMonth: 15 });
    expect(parseExpression("monthly", "31 07:05").dayOfMonth).toBe(28);
    expect(parseExpression("daily", "25:99").time).toBe("07:05");
  });
});

describe("nextRunAt per schedule type (owner timezone)", () => {
  // Saturday 12 Sep 2026, 12:00 Denver (18:00Z, MDT = UTC-6)
  const now = new Date("2026-09-12T18:00:00Z");

  it("manual never runs; inactive jobs never schedule", () => {
    expect(nextRunAt(job("manual"), now, TZ)).toBeNull();
    expect(nextRunAt(job("daily", "07:05", "paused"), now, TZ)).toBeNull();
    expect(nextRunAt(job("daily", "07:05", "draft"), now, TZ)).toBeNull();
  });
  it("continuous is the next tick; hourly is the top of the next hour", () => {
    expect(nextRunAt(job("continuous"), now, TZ)!.toISOString()).toBe("2026-09-12T18:01:00.000Z");
    expect(nextRunAt(job("hourly"), new Date("2026-09-12T18:20:00Z"), TZ)!.toISOString()).toBe("2026-09-12T19:00:00.000Z");
  });
  it("daily runs tomorrow at 07:05 local when today's slot has passed, today otherwise", () => {
    expect(nextRunAt(job("daily", "07:05"), now, TZ)!.toISOString()).toBe("2026-09-13T13:05:00.000Z");
    expect(nextRunAt(job("daily", "19:00"), now, TZ)!.toISOString()).toBe("2026-09-13T01:00:00.000Z");
  });
  it("weekly picks the next matching weekday; monthly the next matching day", () => {
    const fri = nextRunAt(job("weekly", "fri 07:05"), now, TZ)!;
    expect(fri.toISOString()).toBe("2026-09-18T13:05:00.000Z");
    expect(localTime(fri, TZ).weekday).toBe(5);
    const first = nextRunAt(job("monthly", "1 07:05"), now, TZ)!;
    expect(first.toISOString()).toBe("2026-10-01T13:05:00.000Z");
    // Same weekday as now, later today → today.
    expect(nextRunAt(job("weekly", "sat 15:00"), now, TZ)!.toISOString()).toBe("2026-09-12T21:00:00.000Z");
  });
  it("custom cron resolves in owner-local time", () => {
    expect(nextCustom(now, TZ, "30 9 * * 1-5")!.toISOString()).toBe("2026-09-14T15:30:00.000Z"); // Monday 09:30 MDT
    expect(nextRunAt(job("custom", "*/15 * * * *"), now, TZ)!.toISOString()).toBe("2026-09-12T18:15:00.000Z");
    expect(nextCustom(now, TZ, "bad")).toBeNull();
  });
  it("event-driven jobs keep a daily safety tick", () => {
    expect(nextRunAt(job("event_driven", "07:05"), now, TZ)!.toISOString()).toBe("2026-09-13T13:05:00.000Z");
  });
});

describe("DST", () => {
  it("07:05 local stays 07:05 local across the November fall-back (UTC offset changes)", () => {
    // Sat 31 Oct 2026 12:00 Denver (MDT). DST ends Sun 1 Nov 2026 02:00.
    const before = new Date("2026-10-31T18:00:00Z");
    const sun = nextRunAt(job("daily", "07:05"), before, TZ)!;
    expect(localTime(sun, TZ)).toMatchObject({ hour: 7, minute: 5, day: 1, month: 11 });
    expect(sun.toISOString()).toBe("2026-11-01T14:05:00.000Z"); // MST = UTC-7
    const mon = nextRunAt(job("daily", "07:05"), sun, TZ)!;
    expect(mon.toISOString()).toBe("2026-11-02T14:05:00.000Z");
    expect(mon.getTime() - sun.getTime()).toBe(86_400_000);
  });
  it("spring-forward: the Sunday run lands on the right local time (23h gap)", () => {
    // DST starts Sun 8 Mar 2026 02:00 Denver.
    const sat = new Date("2026-03-07T20:00:00Z"); // 13:00 MST
    const sun = nextRunAt(job("daily", "07:05"), sat, TZ)!;
    expect(sun.toISOString()).toBe("2026-03-08T13:05:00.000Z"); // 07:05 MDT (UTC-6)
    expect(localTime(sun, TZ)).toMatchObject({ hour: 7, minute: 5 });
    expect(zonedToUtc(2026, 3, 8, "07:05", TZ).toISOString()).toBe("2026-03-08T13:05:00.000Z");
    expect(zonedToUtc(2026, 3, 7, "07:05", TZ).toISOString()).toBe("2026-03-07T14:05:00.000Z"); // day before: MST (UTC-7)
  });
});

describe("dueJobs + describeSchedule", () => {
  const now = new Date("2026-09-12T18:00:00Z");
  it("selects active, non-manual jobs whose next_run_at has passed or is unset", () => {
    const rows = [
      { id: "a", status: "active", schedule_type: "daily", schedule_expression: null, next_run_at: "2026-09-12T17:59:00Z" },
      { id: "b", status: "active", schedule_type: "daily", schedule_expression: null, next_run_at: "2026-09-12T18:01:00Z" },
      { id: "c", status: "active", schedule_type: "daily", schedule_expression: null, next_run_at: null },
      { id: "d", status: "paused", schedule_type: "daily", schedule_expression: null, next_run_at: null },
      { id: "e", status: "active", schedule_type: "manual", schedule_expression: null, next_run_at: null },
    ] as const;
    expect(dueJobs([...rows], now).map((j) => j.id)).toEqual(["a", "c"]);
  });
  it("describes schedules in plain words", () => {
    expect(describeSchedule({ schedule_type: "weekly", schedule_expression: "fri 07:05" })).toBe("Weekly · Friday 07:05");
    expect(describeSchedule({ schedule_type: "monthly", schedule_expression: "1 07:05" })).toBe("Monthly · day 1 07:05");
    expect(describeSchedule({ schedule_type: "event_driven", schedule_expression: null })).toBe("Event-driven + daily check");
    expect(describeSchedule({ schedule_type: "manual", schedule_expression: null })).toBe("Manual");
  });
});
