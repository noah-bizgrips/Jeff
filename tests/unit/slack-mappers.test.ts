import { describe, expect, it } from "vitest";
import { buildUserDirectory, isHumanMessage, mapChannel, mapMessage, newestTs, permalinkFor, resolveMentions } from "@/lib/integrations/sync/slack-mappers";
import { classifyAuthor } from "@/lib/jeff/rules/engine";
import { missedCommitment } from "@/lib/jeff/monitors/missed-commitment";
import type { SourceRow } from "@/lib/jeff/monitors/types";

const users = buildUserDirectory([
  { id: "U1", name: "noah", real_name: "Noah B", profile: { display_name: "noah", real_name: "Noah B" } },
  { id: "U2", name: "maya", profile: { display_name: "", real_name: "Maya Patel" } },
  { id: "UB", name: "deploybot", is_bot: true, profile: { display_name: "Deploy Bot" } },
]);
const channel = { id: "C123", name: "project-atlas" };

describe("Slack mappers", () => {
  it("builds a directory of display names only", () => {
    expect(users.get("U1")).toBe("noah");
    expect(users.get("U2")).toBe("Maya Patel");
    expect(JSON.stringify([...users.values()])).not.toMatch(/@/);
  });

  it("excludes bot and system-event messages", () => {
    expect(isHumanMessage({ ts: "1", bot_id: "B1", text: "deployed" })).toBe(false);
    expect(isHumanMessage({ ts: "1", user: "U1", subtype: "channel_join" })).toBe(false);
    expect(isHumanMessage({ ts: "1", user: "U1", subtype: "bot_message" })).toBe(false);
    expect(isHumanMessage({ ts: "1", user: "U1", text: "hi" })).toBe(true);
    expect(mapMessage({ ts: "1726000000.000100", bot_id: "B1", text: "Build failed" }, channel, users, "bizgrips")).toBeNull();
  });

  it("resolves mentions, composes permalinks and truncates", () => {
    const text = "Hey <@U2>, see <#C999|general> and <https://example.com|the doc> " + "x".repeat(600);
    const item = mapMessage({ ts: "1726000000.000100", user: "U1", text, thread_ts: "1725999999.000000", reply_count: 0, reactions: [{ name: "+1", count: 2 }] }, channel, users, "bizgrips")!;
    expect(item.resource_type).toBe("message");
    expect(item.external_id).toBe("C123:1726000000.000100");
    expect(item.author).toBe("noah");
    expect(item.title).toContain("#project-atlas · noah: Hey @Maya Patel, see #general and the doc (https://example.com)");
    expect(item.title.length).toBeLessThan(140);
    expect(item.summary!.length).toBeLessThanOrEqual(400);
    expect(item.source_url).toBe("https://bizgrips.slack.com/archives/C123/p1726000000000100?thread_ts=1725999999.000000&cid=C123");
    expect(item.source_timestamp).toBe("2024-09-10T20:26:40.000Z");
    expect(item.metadata).toMatchObject({ channel: "project-atlas", is_thread_reply: true, reactions: 2, author_type: "human" });
    expect(item.tags).toEqual(["slack", "project-atlas"]);
    expect(JSON.stringify(item)).not.toMatch(/@[a-z]+\.[a-z]{2,}/);
  });

  it("maps channels and computes the newest cursor", () => {
    const c = mapChannel({ id: "C123", name: "project-atlas", topic: { value: "Atlas launch" }, num_members: 5, is_member: true }, "bizgrips");
    expect(c).toMatchObject({ resource_type: "channel", title: "#project-atlas", summary: "Atlas launch", source_url: "https://bizgrips.slack.com/archives/C123" });
    expect(newestTs([{ ts: "1.000001" }, { ts: "3.500000" }, { ts: "2.000000" }], "2.5")).toBe("3.500000");
    expect(newestTs([], null)).toBeNull();
    expect(permalinkFor(null, "C1", "1.1")).toBeNull();
    expect(resolveMentions("<!channel> ping &amp; &lt;x&gt;", users)).toBe("@channel ping & <x>");
  });
});

function row(over: Partial<SourceRow>): SourceRow {
  return {
    id: over.id ?? "r1",
    provider: "slack",
    capability: "search",
    resource_type: "message",
    external_id: over.external_id ?? "C123:1",
    title: over.title ?? null,
    summary: over.summary ?? null,
    author: over.author ?? "Maya Patel",
    source_url: null,
    source_timestamp: over.source_timestamp ?? "2026-09-05T15:00:00Z",
    tags: ["slack", "project-atlas"],
    metadata: over.metadata ?? { channel_id: "C123", ts: "1", author_type: "human" },
  };
}

describe("Slack messages in the commitment pipeline", () => {
  it("classifies bot posts as bot and human posts as human", () => {
    expect(classifyAuthor(row({ metadata: { bot_id: "B1" } }))).toBe("bot");
    expect(classifyAuthor(row({ metadata: { subtype: "channel_join" } }))).toBe("system");
    expect(classifyAuthor(row({}))).toBe("human");
  });

  it("detects an open commitment in a human Slack message and ignores a later reply from someone else", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const open = missedCommitment.run([row({ summary: "I'll send the revised proposal by Thursday.", title: "#project-atlas · Maya Patel: I'll send the revised proposal by Thursday." })], { now, ownerId: "o" } as never);
    expect(open).toHaveLength(1);
    expect(open[0]!.observed_facts[0]).toContain("Slack message");
    const replied = missedCommitment.run(
      [
        row({ id: "r1", summary: "I'll send the revised proposal by Thursday.", title: "…", metadata: { channel_id: "C123", ts: "1", thread_ts: "1", author_type: "human" } }),
        row({ id: "r2", external_id: "C123:2", author: "noah", summary: "Got it, thanks!", title: "…", source_timestamp: "2026-09-06T15:00:00Z", metadata: { channel_id: "C123", ts: "2", thread_ts: "1", author_type: "human" } }),
      ],
      { now, ownerId: "o" } as never,
    );
    expect(replied).toHaveLength(0);
  });
});
