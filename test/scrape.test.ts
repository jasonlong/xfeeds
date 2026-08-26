import { describe, expect, it } from "vitest";
import { normalizeRawPost } from "../src/normalize";

describe("post normalization", () => {
  it("normalizes stable X status data", () => {
    const post = normalizeRawPost(
      "almonk",
      {
        id: "1234567890123456789",
        authorHandle: "almonk",
        authorName: "almonk",
        path: "/almonk/status/1234567890123456789?ref_src=test",
        body: " hello ",
        publishedAt: "2026-08-25T12:00:00Z",
        isReply: false,
        media: ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/a.jpg"],
      },
      "2026-08-25T12:01:00Z",
    );
    expect(post).toMatchObject({
      id: "1234567890123456789",
      url: "https://x.com/almonk/status/1234567890123456789",
      body: "hello",
      isRepost: false,
      media: ["https://pbs.twimg.com/a.jpg"],
    });
  });

  it("marks cross-author posts as reposts", () => {
    const post = normalizeRawPost(
      "almonk",
      {
        id: "1234567890123456789",
        authorHandle: "avstorm",
        authorName: "Andreas Storm",
        path: "/avstorm/status/1234567890123456789",
        body: "A repost",
        publishedAt: "2026-08-25T12:00:00Z",
        isReply: false,
        media: [],
      },
      "2026-08-25T12:01:00Z",
    );
    expect(post?.isRepost).toBe(true);
  });

  it("rejects malformed status paths", () => {
    expect(
      normalizeRawPost(
        "almonk",
        {
          id: "not-an-id",
          authorHandle: "almonk",
          authorName: "almonk",
          path: "/home",
          body: "invalid",
          publishedAt: "not-a-date",
          isReply: false,
          media: [],
        },
        "2026-08-25T12:01:00Z",
      ),
    ).toBeUndefined();
  });
});
