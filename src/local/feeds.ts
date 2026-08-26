import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { accounts } from "../accounts";
import type { CollectedPost } from "../model";
import { renderRss } from "../rss";
import type { AccountAvatars } from "./avatars";
import { toStoredRow } from "./store";

function feedUrl(baseUrl: string, fileName: string): string {
  return new URL(`feeds/${fileName}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function generateFeeds(
  posts: CollectedPost[],
  outputDir: string,
  baseUrl = "http://localhost:8787/",
  avatars: AccountAvatars = {},
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const rows = posts.map(toStoredRow);
  const writeFeed = (fileName: string, xml: string) =>
    writeFile(path.join(outputDir, fileName), xml, "utf8");

  await writeFeed("all.xml", renderRss({
    title: "X feeds",
    description: "Collected posts from configured X accounts",
    feedUrl: feedUrl(baseUrl, "all.xml"),
    homeUrl: "https://x.com/",
    posts: rows.slice(0, 200),
  }));

  for (const account of accounts) {
    const fileName = `${account.handle}.xml`;
    await writeFeed(fileName, renderRss({
      title: `${account.name} / @${account.handle}`,
      description: `Recent X posts collected for @${account.handle}`,
      feedUrl: feedUrl(baseUrl, fileName),
      homeUrl: `https://x.com/${account.handle}`,
      imageUrl: avatars[account.handle.toLowerCase()],
      posts: rows
        .filter((post) => post.handle.toLowerCase() === account.handle.toLowerCase())
        .slice(0, 100),
    }));
  }

  const accountLinks = accounts.map((account) => {
    const image = avatars[account.handle.toLowerCase()];
    const icon = image
      ? `<img src="${escapeHtml(image)}" alt="" width="40" height="40">`
      : "";
    return `<li>${icon}<a href="feeds/${encodeURIComponent(account.handle)}.xml">${escapeHtml(account.name)} / @${escapeHtml(account.handle)}</a></li>`;
  }).join("\n      ");
  await writeFile(path.join(outputDir, "..", "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>xfeeds</title>
  <style>body{font:16px system-ui;max-width:680px;margin:4rem auto;padding:0 1rem;color:#171717}ul{list-style:none;padding:0}li{display:flex;align-items:center;gap:.75rem;margin:1rem 0}img{border-radius:20%;object-fit:cover}a{color:inherit}</style>
</head>
<body>
  <h1>xfeeds</h1>
  <p>RSS feeds generated from public X profiles.</p>
  <p><a href="feeds/all.xml">All accounts</a></p>
  <ul>
      ${accountLinks}
  </ul>
</body>
</html>
`, "utf8");
}
