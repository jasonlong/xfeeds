import {
  launch,
  type Browser,
  type BrowserContext,
  type BrowserWorker,
  type Page,
} from "@cloudflare/playwright";
import type { StorageState } from "./auth-state";
import type { CollectedPost, ScrapeResult } from "./model";
import { normalizeRawPost } from "./normalize";
import { extractRawPostsFromArticles, validatedAvatarUrl } from "./timeline";

export interface ScrapeOptions {
  binding: BrowserWorker;
  handles: string[];
  maxPostsPerHandle: number;
  deadlineMs: number;
  storageState: StorageState;
}

export type ScrapeInfrastructureStage =
  | "browser-launch"
  | "context-create"
  | "page-scrape"
  | "storage-state-export";

export class ScrapeInfrastructureError extends Error {
  constructor(
    readonly stage: ScrapeInfrastructureStage,
    readonly sessionId: string | null,
    readonly originalName: string,
  ) {
    super(`Browser Run failed during ${stage}`);
    this.name = "ScrapeInfrastructureError";
  }
}

function browserSessionId(browser: Browser | undefined): string | null {
  try {
    return browser?.sessionId() ?? null;
  } catch {
    return null;
  }
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
    const challengeVisible = page.url().includes("/account/access") || await page
      .getByText(/verify your identity|authenticate your account|suspicious activity/i)
      .first()
      .isVisible()
      .catch(() => false);
    const rateLimitVisible = await page
      .getByText(/rate limit exceeded|try again later/i)
      .first()
      .isVisible()
      .catch(() => false);
    const consentVisible = await page
      .getByText(/accept all cookies|refuse non-essential cookies/i)
      .first()
      .isVisible()
      .catch(() => false);
    return {
      handle,
      posts: [],
      errorCode: loginVisible
        ? "login-required"
        : challengeVisible
        ? "auth-challenge"
        : rateLimitVisible
        ? "rate-limited"
        : consentVisible
        ? "consent-required"
        : "no-posts-visible",
    };
  }

  const avatar = page.locator(`a[href="/${handle}/photo"] img`);
  const avatarUrl = validatedAvatarUrl(
    await avatar.count() === 1 ? await avatar.getAttribute("src") : null,
  );
  const discoveredAt = new Date().toISOString();
  const byId = new Map<string, CollectedPost>();
  let roundsWithoutGrowth = 0;
  for (let round = 0; round < 10 && byId.size < maxPosts; round += 1) {
    if (Date.now() >= deadline - 1_000) break;
    const before = byId.size;
    const rawPosts = await tweets.evaluateAll(extractRawPostsFromArticles, maxPosts * 2);
    for (const rawPost of rawPosts) {
      const post = normalizeRawPost(handle, rawPost, discoveredAt);
      if (post) byId.set(post.id, post);
    }
    roundsWithoutGrowth = byId.size === before ? roundsWithoutGrowth + 1 : 0;
    if (byId.size >= maxPosts || roundsWithoutGrowth >= 2) break;
    await page.mouse.wheel(0, 1_800);
    await page.waitForTimeout(remaining(deadline, 1_200));
  }

  return {
    handle,
    posts: [...byId.values()]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, maxPosts),
    avatarUrl,
  };
}

export async function scrapeAccounts(options: ScrapeOptions): Promise<{
  results: ScrapeResult[];
  browserMs: number;
  updatedStorageState: StorageState;
}> {
  const started = Date.now();
  const deadline = started + options.deadlineMs;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const results: ScrapeResult[] = [];
  let updatedStorageState: StorageState | undefined;
  let stage: ScrapeInfrastructureStage = "browser-launch";
  try {
    browser = await launch(options.binding, {
      recording: false,
      guardrails: {
        allowedDomains: [
          "x.com",
          "*.x.com",
          "twitter.com",
          "*.twitter.com",
          "*.twimg.com",
          "t.co",
        ],
        allowedDomainSets: ["common-cdns"],
      },
    });
    stage = "context-create";
    context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      storageState: options.storageState,
    });
    stage = "page-scrape";
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
    stage = "storage-state-export";
    updatedStorageState = await context.storageState();
  } catch (error) {
    throw new ScrapeInfrastructureError(
      stage,
      browserSessionId(browser),
      error instanceof Error ? error.name : "UnknownError",
    );
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
  if (!updatedStorageState) throw new Error("browser-storage-state-unavailable");
  return { results, browserMs: Date.now() - started, updatedStorageState };
}
