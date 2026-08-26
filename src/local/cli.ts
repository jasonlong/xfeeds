import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { accounts, configuredAccount } from "../accounts";
import { readAvatars, writeAvatars } from "./avatars";
import { hasSignedInSession, launchProfile, scrapeHandle } from "./browser";
import { generateFeeds } from "./feeds";
import { avatarsPath, browserProfileDir, feedsDir, storePath } from "./paths";
import { serve } from "./server";
import { mergePosts, readPosts, writePosts } from "./store";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

async function authenticate(): Promise<void> {
  await mkdir(browserProfileDir, { recursive: true, mode: 0o700 });
  console.log("Chrome is opening normally with the dedicated xrss profile.");
  console.log("Sign in to X, then quit that Chrome window to finish saving the session.");
  const chrome = spawn("/usr/bin/open", [
    "-W",
    "-n",
    "-a",
    "Google Chrome",
    "--args",
    `--user-data-dir=${browserProfileDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "https://x.com/login",
  ], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    chrome.once("error", reject);
    chrome.once("exit", (code) => code === 0 || code === null
      ? resolve()
      : reject(new Error(`Chrome exited with status ${code}`)));
  });

  const context = await launchProfile(true);
  try {
    if (await hasSignedInSession(context)) {
      console.log("Saved the signed-in session in .xrss/browser-profile.");
      return;
    }
    throw new Error("X login was not found in the dedicated profile. Run npm run auth and try again.");
  } finally {
    await context.close();
  }
}

async function collect(): Promise<void> {
  const requested = option("--handle") ?? accounts[0]?.handle;
  const requestedAccount = requested ? configuredAccount(requested) : undefined;
  if (!process.argv.includes("--all") && !requestedAccount) {
    throw new Error(`Unknown configured handle: ${requested ?? "(none)"}`);
  }
  const selectedAccounts = process.argv.includes("--all")
    ? accounts
    : requestedAccount ? [requestedAccount] : [];
  const maxPosts = positiveInteger(option("--max-posts"), 20, 50);
  const baseUrl = option("--base-url") ?? process.env.XFEEDS_BASE_URL ??
    "https://jasonlong.github.io/xfeeds/";
  const headed = process.argv.includes("--headed");

  const context = await launchProfile(!headed);
  try {
    if (!(await hasSignedInSession(context))) {
      throw new Error("No signed-in X session found; run npm run auth first.");
    }
    const collected = [];
    const avatars = await readAvatars(avatarsPath);
    const failures: string[] = [];
    for (const account of selectedAccounts) {
      try {
        const scraped = await scrapeHandle(context, account.handle, maxPosts);
        if (scraped.posts.length === 0) throw new Error("no posts found");
        collected.push(...scraped.posts);
        if (scraped.avatarUrl) avatars[account.handle.toLowerCase()] = scraped.avatarUrl;
        console.log(`Collected ${scraped.posts.length} posts from @${account.handle}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`@${account.handle}: ${message}`);
        console.error(`Could not collect @${account.handle}: ${message}`);
      }
    }
    if (collected.length === 0) throw new Error("No configured accounts could be collected.");

    const merged = mergePosts(await readPosts(storePath), collected);
    await writePosts(storePath, merged);
    await writeAvatars(avatarsPath, avatars);
    await generateFeeds(merged, feedsDir, baseUrl, avatars);
    console.log(`Stored ${merged.length} posts and wrote ${selectedAccounts.length + 1} feeds.`);
    if (failures.length > 0) console.warn(`${failures.length} account(s) failed this run.`);
  } finally {
    await context.close();
  }
}

async function publish(): Promise<void> {
  await collect();
  execFileSync("/usr/bin/git", ["add", "--", "docs"], { cwd: process.cwd() });
  const diff = spawnSync("/usr/bin/git", ["diff", "--cached", "--quiet"], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  if (diff.status === 0) {
    console.log("Published feeds are already current; nothing to push.");
    return;
  }
  if (diff.status !== 1) throw new Error("Could not inspect generated feed changes.");
  execFileSync("/usr/bin/git", ["commit", "-m", "Update feeds"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  execFileSync("/usr/bin/git", ["push", "origin", "main"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

const command = process.argv[2];
try {
  if (command === "auth") await authenticate();
  else if (command === "collect") await collect();
  else if (command === "publish") await publish();
  else if (command === "serve") await serve(positiveInteger(option("--port"), 8787, 65_535));
  else throw new Error("Usage: npm run auth | npm run collect -- [--handle HANDLE | --all] | npm run feeds:publish | npm run serve");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
