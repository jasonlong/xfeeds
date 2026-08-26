import { launch, type Browser, type Page } from "@cloudflare/playwright";
import type { CollectedPost, ScrapeResult } from "./model";
import { normalizeRawPost, type RawPost } from "./normalize";

interface BrowserBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ScrapeOptions {
  binding: BrowserBinding;
  handles: string[];
  maxPostsPerHandle: number;
  deadlineMs: number;
}

function remaining(deadline: number, ceiling: number): number {
  return Math.max(1_000, Math.min(ceiling, deadline - Date.now()));
}

async function scrapePage(
  page: Page,
  handle: string,
  maxPosts: number,
  deadline: number,
): Promise<ScrapeResult> {
  page.setDefaultTimeout(remaining(deadline, 12_000));
  page.setDefaultNavigationTimeout(remaining(deadline, 15_000));

  await page.route("**/*", async (route) => {
    const kind = route.request().resourceType();
    if (kind === "font" || kind === "media") await route.abort();
    else await route.continue();
  });

  const response = await page.goto(`https://x.com/${encodeURIComponent(handle)}`, {
    waitUntil: "domcontentloaded",
    timeout: remaining(deadline, 15_000),
  });

  if (response && response.status() >= 400) {
    return { handle, posts: [], errorCode: `http-${response.status()}` };
  }
  if (page.url().includes("/i/flow/login")) {
    return { handle, posts: [], errorCode: "login-required" };
  }

  const tweets = page.locator('[data-testid="tweet"]');
  try {
    await tweets.first().waitFor({
      state: "visible",
      timeout: remaining(deadline, 12_000),
    });
  } catch {
    const loginVisible = await page
      .getByText("Sign in", { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    return {
      handle,
      posts: [],
      errorCode: loginVisible ? "login-required" : "no-posts-visible",
    };
  }

  const raw = await tweets.evaluateAll(
    (articles, limit) => {
      const output: RawPost[] = [];
      for (const article of articles.slice(0, limit)) {
        const time = article.querySelector("time[datetime]");
        const statusAnchor = time?.closest('a[href*="/status/"]') as HTMLAnchorElement | null;
        const path = statusAnchor?.getAttribute("href") ?? "";
        const match = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
        if (!match) continue;

        const userName = article.querySelector('[data-testid="User-Name"]');
        const handleText = [...(userName?.querySelectorAll("span") ?? [])]
          .map((node) => node.textContent?.trim() ?? "")
          .find((value) => /^@[A-Za-z0-9_]{1,15}$/.test(value));
        const authorHandle = handleText?.slice(1) ?? match[1] ?? "";
        const nameText = userName?.querySelector("span")?.textContent?.trim() ?? authorHandle;
        const body = article.querySelector('[data-testid="tweetText"]')?.textContent ?? "";
        const replying = [...article.querySelectorAll("span")].some((node) =>
          node.textContent?.startsWith("Replying to"),
        );
        const media = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
          .map((node) => (node as HTMLImageElement).src)
          .filter((url) => url.startsWith("https://pbs.twimg.com/"));

        output.push({
          id: match[2] ?? "",
          authorHandle,
          authorName: nameText,
          path,
          body,
          publishedAt: time?.getAttribute("datetime") ?? "",
          isReply: replying,
          media,
        });
      }
      return output;
    },
    maxPosts,
  );

  const discoveredAt = new Date().toISOString();
  const posts = raw
    .map((post) => normalizeRawPost(handle, post, discoveredAt))
    .filter((post): post is CollectedPost => post !== undefined);
  return { handle, posts };
}

export async function scrapeAccounts(options: ScrapeOptions): Promise<{
  results: ScrapeResult[];
  browserMs: number;
}> {
  const started = Date.now();
  const deadline = started + options.deadlineMs;
  let browser: Browser | undefined;
  try {
    browser = await launch(options.binding);
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
    });
    const results: ScrapeResult[] = [];
    for (const handle of options.handles) {
      if (Date.now() >= deadline - 1_000) {
        results.push({ handle, posts: [], errorCode: "run-deadline" });
        continue;
      }
      const page = await context.newPage();
      try {
        results.push(
          await scrapePage(page, handle, options.maxPostsPerHandle, deadline),
        );
      } catch (error) {
        const code = error instanceof Error && error.name === "TimeoutError"
          ? "page-timeout"
          : "page-failed";
        results.push({ handle, posts: [], errorCode: code });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    await context.close();
    return { results, browserMs: Date.now() - started };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
