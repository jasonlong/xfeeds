import { describe, expect, it } from "vitest";
import { mergePosts, toStoredRow } from "../src/local/store";
import type { CollectedPost } from "../src/model";

function post(id: string, publishedAt: string, body = id, handle = "almonk"): CollectedPost {
  return {
    id,
    handle,
    authorHandle: handle,
    authorName: handle,
    url: `https://x.com/${handle}/status/${id}`,
    body,
    publishedAt,
    discoveredAt: publishedAt,
    isReply: false,
    isRepost: false,
    media: [],
  };
}

describe("local post storage", () => {
  it("deduplicates, refreshes, and sorts posts", () => {
    const merged = mergePosts(
      [post("11111", "2026-08-25T10:00:00.000Z", "old")],
      [post("11111", "2026-08-25T10:00:00.000Z", "updated"), post("22222", "2026-08-25T11:00:00.000Z")],
    );
    expect(merged.map((value) => value.id)).toEqual(["22222", "11111"]);
    expect(merged[1]?.body).toBe("updated");
  });

  it("converts posts into RSS rows", () => {
    expect(toStoredRow(post("11111", "2026-08-25T10:00:00.000Z"))).toMatchObject({
      id: "11111",
      is_reply: 0,
      is_repost: 0,
      media_json: "[]",
    });
  });

  it("retains the same repost when it appears in different account feeds", () => {
    const merged = mergePosts(
      [post("11111", "2026-08-25T10:00:00.000Z", "shared", "almonk")],
      [post("11111", "2026-08-25T10:00:00.000Z", "shared", "avstorm")],
    );
    expect(merged.map((value) => value.handle).sort()).toEqual(["almonk", "avstorm"]);
  });
});
