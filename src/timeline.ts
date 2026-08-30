import type { RawPost } from "./normalize";

export function extractRawPostsFromArticles(
  articles: Element[],
  requestedLimit: number,
): RawPost[] {
  const output: RawPost[] = [];
  for (const article of articles.slice(0, requestedLimit)) {
    const time = article.querySelector("time[datetime]");
    const statusAnchor = time?.closest('a[href*="/status/"]') as HTMLAnchorElement | null;
    const statusPath = statusAnchor?.getAttribute("href") ?? "";
    const match = statusPath.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (!match) continue;

    const userName = article.querySelector('[data-testid="User-Name"]');
    const handleText = [...(userName?.querySelectorAll("span") ?? [])]
      .map((node) => node.textContent?.trim() ?? "")
      .find((value) => /^@[A-Za-z0-9_]{1,15}$/.test(value));
    const authorHandle = handleText?.slice(1) ?? match[1] ?? "";
    const authorName = userName?.querySelector("span")?.textContent?.trim() ?? authorHandle;
    const body = article.querySelector('[data-testid="tweetText"]')?.textContent ?? "";
    const isReply = [...article.querySelectorAll("span")].some((node) =>
      node.textContent?.startsWith("Replying to")
    );
    const media = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .map((node) => (node as HTMLImageElement).src)
      .filter((url) => url.startsWith("https://pbs.twimg.com/"));

    output.push({
      id: match[2] ?? "",
      authorHandle,
      authorName,
      path: statusPath,
      body,
      publishedAt: time?.getAttribute("datetime") ?? "",
      isReply,
      media,
    });
  }
  return output;
}

export function validatedAvatarUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
        (url.hostname === "pbs.twimg.com" || url.hostname === "abs.twimg.com")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
