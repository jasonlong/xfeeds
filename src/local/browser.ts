import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { CollectedPost } from "../model";
import { normalizeRawPost, type RawPost } from "../normalize";
import { extractRawPostsFromArticles, validatedAvatarUrl } from "../timeline";
import { browserProfileDir } from "./paths";

export interface LocalScrapeResult {
  posts: CollectedPost[];
  avatarUrl?: string;
}

export async function launchProfile(headless: boolean): Promise<BrowserContext> {
  await mkdir(browserProfileDir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(browserProfileDir, {
    channel: "chrome",
    headless,
    // Native Chrome writes cookies with the macOS keychain. Playwright's mock
    // keychain cannot read them and may discard them when the profile opens.
    ignoreDefaultArgs: ["--use-mock-keychain"],
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  });
}

export async function hasSignedInSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://x.com/");
  return cookies.some((cookie) => cookie.name === "auth_token" && cookie.value.length > 0);
}

async function extractVisiblePosts(page: Page, limit: number): Promise<RawPost[]> {
  return page.locator('[data-testid="tweet"]').evaluateAll(extractRawPostsFromArticles, limit);
}

export async function scrapeHandle(
  context: BrowserContext,
  handle: string,
  maxPosts: number,
): Promise<LocalScrapeResult> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.route("**/*", async (route) => {
    const kind = route.request().resourceType();
    if (kind === "font" || kind === "media") await route.abort();
    else await route.continue();
  });

  try {
    const response = await page.goto(`https://x.com/${encodeURIComponent(handle)}`, {
      waitUntil: "domcontentloaded",
    });
    if (response && response.status() >= 400) {
      throw new Error(`X returned HTTP ${response.status()} for @${handle}`);
    }
    if (page.url().includes("/i/flow/login")) {
      throw new Error("The saved X session has expired; run npm run auth again.");
    }

    const tweets = page.locator('[data-testid="tweet"]');
    await tweets.first().waitFor({ state: "visible", timeout: 20_000 });

    const avatar = page.locator(`a[href="/${handle}/photo"] img`);
    const avatarUrl = await avatar.count() === 1
      ? await avatar.getAttribute("src") ?? undefined
      : undefined;
    const safeAvatarUrl = validatedAvatarUrl(avatarUrl ?? null);

    const discoveredAt = new Date().toISOString();
    const byId = new Map<string, CollectedPost>();
    let roundsWithoutGrowth = 0;
    for (let round = 0; round < 10 && byId.size < maxPosts; round += 1) {
      const before = byId.size;
      for (const raw of await extractVisiblePosts(page, maxPosts * 2)) {
        const post = normalizeRawPost(handle, raw, discoveredAt);
        if (post) byId.set(post.id, post);
      }
      roundsWithoutGrowth = byId.size === before ? roundsWithoutGrowth + 1 : 0;
      if (byId.size >= maxPosts || roundsWithoutGrowth >= 2) break;
      await page.mouse.wheel(0, 1_800);
      await page.waitForTimeout(1_200);
    }

    return {
      posts: [...byId.values()]
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, maxPosts),
      avatarUrl: safeAvatarUrl,
    };
  } catch (error) {
    if (await page.getByText("Sign in", { exact: true }).first().isVisible().catch(() => false)) {
      throw new Error("The saved X session has expired; run npm run auth again.");
    }
    throw error;
  } finally {
    await page.close();
  }
}
