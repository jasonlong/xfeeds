import { describe, expect, it } from "vitest";
import { escapeXml, renderRss } from "../src/rss";
import type { StoredPostRow } from "../src/model";

const post: StoredPostRow = {
  id: "1234567890",
  handle: "almonk",
  author_handle: "almonk",
  author_name: "almonk",
  url: "https://x.com/almonk/status/1234567890",
  body: "A <small> post & a second line\nwith detail",
  published_at: "2026-08-25T12:00:00.000Z",
  discovered_at: "2026-08-25T12:01:00.000Z",
  is_reply: 0,
  is_repost: 0,
  media_json: '["https://pbs.twimg.com/media/example.jpg"]',
};

describe("RSS rendering", () => {
  it("escapes XML metadata", () => {
    expect(escapeXml(`<&>\"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("uses stable post URLs as GUIDs and preserves safe content", () => {
    const xml = renderRss({
      title: "almonk / @almonk",
      description: "Recent posts",
      feedUrl: "https://example.com/feeds/almonk.xml",
      homeUrl: "https://x.com/almonk",
      imageUrl: "https://pbs.twimg.com/profile_images/avatar.jpg?size=200",
      posts: [post],
    });
    expect(xml).toContain(`<guid isPermaLink="true">${post.url}</guid>`);
    expect(xml).toContain("A &lt;small&gt; post &amp; a second line<br>with detail");
    expect(xml).toContain("https://pbs.twimg.com/media/example.jpg");
    expect(xml).toContain(
      "<webfeeds:icon>https://pbs.twimg.com/profile_images/avatar.jpg?size=200</webfeeds:icon>",
    );
    expect(xml).toContain("<image>");
  });
});
