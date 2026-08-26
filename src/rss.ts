import type { StoredPostRow } from "./model";

const encoder = new TextEncoder();

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeMedia(mediaJson: string): string[] {
  try {
    const value: unknown = JSON.parse(mediaJson);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function itemDescription(post: StoredPostRow): string {
  const text = `<p>${escapeXml(post.body).replaceAll("\n", "<br>")}</p>`;
  const images = safeMedia(post.media_json)
    .map((url) => `<p><img src="${escapeXml(url)}" alt=""></p>`)
    .join("");
  return `${text}${images}`;
}

export function renderRss(options: {
  title: string;
  description: string;
  feedUrl: string;
  homeUrl: string;
  imageUrl?: string;
  posts: StoredPostRow[];
}): string {
  const items = options.posts
    .map((post) => {
      const prefix = post.is_repost === 1 ? "Repost: " : "";
      const title = post.body.trim().split(/\s+/).slice(0, 18).join(" ") || "Media post";
      return [
        "    <item>",
        `      <title>${escapeXml(prefix + title)}</title>`,
        `      <link>${escapeXml(post.url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(post.url)}</guid>`,
        `      <pubDate>${new Date(post.published_at).toUTCString()}</pubDate>`,
        `      <author>${escapeXml(`@${post.author_handle}`)}</author>`,
        `      <description><![CDATA[${itemDescription(post)}]]></description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:webfeeds="http://webfeeds.org/rss/1.0">',
    "  <channel>",
    `    <title>${escapeXml(options.title)}</title>`,
    `    <description>${escapeXml(options.description)}</description>`,
    `    <link>${escapeXml(options.homeUrl)}</link>`,
    `    <atom:link href="${escapeXml(options.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    ...(options.imageUrl ? [
      `    <webfeeds:icon>${escapeXml(options.imageUrl)}</webfeeds:icon>`,
      "    <image>",
      `      <url>${escapeXml(options.imageUrl)}</url>`,
      `      <title>${escapeXml(options.title)}</title>`,
      `      <link>${escapeXml(options.homeUrl)}</link>`,
      "    </image>",
    ] : []),
    "    <ttl>120</ttl>",
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

export function rssResponse(xml: string): Response {
  return new Response(encoder.encode(xml), {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
