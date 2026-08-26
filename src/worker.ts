import { accounts, configuredAccount } from "./accounts";
import type { CollectedPost, StoredPostRow } from "./model";
import { renderRss, rssResponse } from "./rss";
import { scrapeAccounts } from "./scrape";

interface BrowserBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  ADMIN_TOKEN?: string;
  BROWSER: BrowserBinding;
  DB: D1Database;
  DEPLOY_MODE: string;
  MAX_HANDLES_PER_RUN: string;
  MAX_POSTS_PER_HANDLE: string;
  RUN_DEADLINE_MS: string;
}

interface CollectRequest {
  handles?: unknown;
  maxPostsPerHandle?: unknown;
}

const securityHeaders = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: securityHeaders });
}

function positiveInt(value: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

async function seedAccounts(db: D1Database): Promise<void> {
  await db.batch(
    accounts.map((account) =>
      db
        .prepare(
          `INSERT INTO accounts (handle, display_name)
           VALUES (?, ?)
           ON CONFLICT(handle) DO UPDATE SET
             display_name = excluded.display_name,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(account.handle, account.name),
    ),
  );
}

function authorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${env.ADMIN_TOKEN}`;
}

function parseCollectRequest(
  body: CollectRequest,
  maxHandles: number,
  configuredMaxPosts: number,
): { handles: string[]; maxPostsPerHandle: number } | Response {
  const requested = Array.isArray(body.handles) ? body.handles : [accounts[0]?.handle];
  if (requested.length === 0 || requested.length > maxHandles) {
    return json({ error: "invalid-handle-count", maximum: maxHandles }, 400);
  }

  const handles: string[] = [];
  for (const value of requested) {
    if (typeof value !== "string") return json({ error: "invalid-handle" }, 400);
    const account = configuredAccount(value);
    if (!account) return json({ error: "unknown-handle", handle: value }, 400);
    handles.push(account.handle);
  }

  const requestedMax = typeof body.maxPostsPerHandle === "number"
    ? Math.floor(body.maxPostsPerHandle)
    : configuredMaxPosts;
  if (requestedMax < 1 || requestedMax > configuredMaxPosts) {
    return json({ error: "invalid-post-limit", maximum: configuredMaxPosts }, 400);
  }
  return { handles, maxPostsPerHandle: requestedMax };
}

async function storePosts(db: D1Database, posts: CollectedPost[]): Promise<number> {
  if (posts.length === 0) return 0;
  const results = await db.batch(
    posts.map((post) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO posts (
             id, handle, author_handle, author_name, url, body,
             published_at, discovered_at, is_reply, is_repost, media_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          post.id,
          post.handle,
          post.authorHandle,
          post.authorName,
          post.url,
          post.body,
          post.publishedAt,
          post.discoveredAt,
          post.isReply ? 1 : 0,
          post.isRepost ? 1 : 0,
          JSON.stringify(post.media),
        ),
    ),
  );
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}

async function collect(request: Request, env: Env): Promise<Response> {
  if (env.DEPLOY_MODE !== "manual-only") return json({ error: "unsafe-deploy-mode" }, 503);
  if (!env.ADMIN_TOKEN) return json({ error: "admin-token-not-configured" }, 503);
  if (!authorized(request, env)) return json({ error: "not-found" }, 404);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return json({ error: "content-type-must-be-json" }, 415);
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 4_096) return json({ error: "request-too-large" }, 413);

  let body: CollectRequest;
  try {
    body = await request.json<CollectRequest>();
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  const maxHandles = positiveInt(env.MAX_HANDLES_PER_RUN, 1, 13);
  const configuredMaxPosts = positiveInt(env.MAX_POSTS_PER_HANDLE, 20, 50);
  const parsed = parseCollectRequest(body, maxHandles, configuredMaxPosts);
  if (parsed instanceof Response) return parsed;

  await seedAccounts(env.DB);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO collection_runs (id, started_at, status, requested_handles)
       VALUES (?, ?, 'running', ?)`,
    )
    .bind(runId, startedAt, parsed.handles.length)
    .run();

  try {
    const result = await scrapeAccounts({
      binding: env.BROWSER,
      handles: parsed.handles,
      maxPostsPerHandle: parsed.maxPostsPerHandle,
      deadlineMs: positiveInt(env.RUN_DEADLINE_MS, 45_000, 45_000),
    });
    const inserted = await storePosts(
      env.DB,
      result.results.flatMap((entry) => entry.posts),
    );
    const failed = result.results.find((entry) => entry.errorCode);
    const finishedAt = new Date().toISOString();

    await env.DB.batch([
      ...result.results.map((entry) =>
        env.DB
          .prepare(
            `UPDATE accounts SET
               last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
               last_error_code = ?,
               updated_at = CURRENT_TIMESTAMP
             WHERE handle = ?`,
          )
          .bind(entry.errorCode ?? null, finishedAt, entry.errorCode ?? null, entry.handle),
      ),
      env.DB
        .prepare(
          `UPDATE collection_runs SET
             finished_at = ?, status = ?, collected_posts = ?, browser_ms = ?, error_code = ?
           WHERE id = ?`,
        )
        .bind(
          finishedAt,
          failed ? "failed" : "ok",
          inserted,
          result.browserMs,
          failed?.errorCode ?? null,
          runId,
        ),
    ]);

    return json({
      runId,
      inserted,
      browserMs: result.browserMs,
      results: result.results.map((entry) => ({
        handle: entry.handle,
        found: entry.posts.length,
        errorCode: entry.errorCode ?? null,
      })),
    });
  } catch {
    await env.DB
      .prepare(
        `UPDATE collection_runs SET
           finished_at = ?, status = 'failed', error_code = 'run-failed'
         WHERE id = ?`,
      )
      .bind(new Date().toISOString(), runId)
      .run();
    return json({ runId, error: "run-failed" }, 502);
  }
}

async function feed(request: Request, env: Env, handle?: string): Promise<Response> {
  const url = new URL(request.url);
  let title = "X feeds";
  let description = "Collected posts from configured X accounts";
  let rows: D1Result<StoredPostRow>;

  if (handle) {
    const account = configuredAccount(handle);
    if (!account) return json({ error: "not-found" }, 404);
    title = `${account.name} / @${account.handle}`;
    description = `Recent X posts collected for @${account.handle}`;
    rows = await env.DB
      .prepare(
        `SELECT * FROM posts WHERE handle = ?
         ORDER BY published_at DESC LIMIT 100`,
      )
      .bind(account.handle)
      .all<StoredPostRow>();
  } else {
    rows = await env.DB
      .prepare(`SELECT * FROM posts ORDER BY published_at DESC LIMIT 200`)
      .all<StoredPostRow>();
  }

  return rssResponse(
    renderRss({
      title,
      description,
      feedUrl: url.toString(),
      homeUrl: "https://x.com/",
      posts: rows.results,
    }),
  );
}

async function health(env: Env): Promise<Response> {
  const latest = await env.DB
    .prepare(
      `SELECT id, started_at, finished_at, status, requested_handles,
              collected_posts, browser_ms, error_code
       FROM collection_runs ORDER BY started_at DESC LIMIT 1`,
    )
    .first();
  const postCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM posts`).first<number>("count");
  return json({
    ok: true,
    deployMode: env.DEPLOY_MODE,
    scheduled: false,
    configuredAccounts: accounts.length,
    storedPosts: postCount ?? 0,
    latestRun: latest ?? null,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/admin/collect") {
      return collect(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method-not-allowed" }, 405);
    }
    if (url.pathname === "/health") return health(env);
    if (url.pathname === "/feeds/all.xml") return feed(request, env);
    const match = url.pathname.match(/^\/feeds\/([A-Za-z0-9_]{1,15})\.xml$/);
    if (match?.[1]) return feed(request, env, match[1]);
    if (url.pathname === "/") {
      return json({
        name: "xrss",
        scheduled: false,
        feeds: ["/feeds/all.xml", ...accounts.map((a) => `/feeds/${a.handle}.xml`)],
      });
    }
    return json({ error: "not-found" }, 404);
  },
} satisfies ExportedHandler<Env>;
