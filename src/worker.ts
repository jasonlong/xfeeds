import { timingSafeEqual } from "node:crypto";
import { accounts, configuredAccount } from "./accounts";
import {
  AUTH_STATE_KV_KEY,
  AuthStateError,
  authStateMetadata,
  decryptStorageState,
  encryptStorageState,
  filterStorageState,
  MAX_AUTH_STATE_BYTES,
  validateStorageState,
  type EncryptedAuthState,
  type StorageState,
} from "./auth-state";
import { scheduledSlot } from "./cloudflare-schedule";
import type { CollectedPost, StoredPostRow } from "./model";
import { renderRss, rssResponse } from "./rss";
import { scrapeAccounts, ScrapeInfrastructureError } from "./scrape";

type WorkerEnv = Omit<Env, "DEPLOY_MODE"> & {
  DEPLOY_MODE: string;
  ADMIN_TOKEN?: string;
  AUTH_STATE_KEY?: string;
};

interface CollectRequest {
  handles?: unknown;
  maxPostsPerHandle?: unknown;
}

interface CollectionOptions {
  handles: string[];
  maxPostsPerHandle: number;
  deadlineMs: number;
  scheduledKey?: string;
}

interface CollectionResult {
  runId: string;
  status: "ok" | "failed" | "duplicate";
  stored: number;
  browserMs: number;
  authStateUpdatedAt: string | null;
  authStateRefreshError: string | null;
  results: Array<{
    handle: string;
    found: number;
    avatarPresent: boolean;
    errorCode: string | null;
  }>;
  error?: "run-failed";
  diagnostic?: {
    stage: string;
    sessionId: string | null;
    errorName: string;
  };
}

function isCollectRequest(value: unknown): value is CollectRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function scheduledMode(env: WorkerEnv): boolean {
  return env.DEPLOY_MODE === "scheduled-daily-et";
}

function collectionModeEnabled(env: WorkerEnv): boolean {
  return env.DEPLOY_MODE === "manual-only" || scheduledMode(env);
}

async function readJsonLimited(request: Request, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new AuthStateError("request-too-large");
  }
  if (!request.body) throw new AuthStateError("invalid-json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new AuthStateError("request-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AuthStateError("invalid-json");
  }
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

async function authorized(request: Request, env: WorkerEnv): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.ADMIN_TOKEN}`)),
  ]);
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

function authStateFailure(error: unknown): Response {
  const code = error instanceof AuthStateError ? error.code : "auth-state-failed";
  const status = code === "request-too-large" ? 413 : code === "invalid-json" ? 400 : 422;
  return json({ error: code }, status);
}

async function loadAuthState(env: WorkerEnv): Promise<{
  storageState: StorageState;
  updatedAt: string;
}> {
  if (!env.AUTH_STATE_KEY) throw new AuthStateError("auth-state-key-not-configured");
  const envelope = await env.AUTH_STATE.get<EncryptedAuthState>(AUTH_STATE_KV_KEY, "json");
  if (!envelope) throw new AuthStateError("auth-state-not-configured");
  return decryptStorageState(envelope, env.AUTH_STATE_KEY);
}

async function saveAuthState(env: WorkerEnv, storageState: StorageState): Promise<string> {
  if (!env.AUTH_STATE_KEY) throw new AuthStateError("auth-state-key-not-configured");
  const updatedAt = new Date().toISOString();
  const filtered = filterStorageState(storageState);
  const envelope = await encryptStorageState(filtered, env.AUTH_STATE_KEY, updatedAt);
  await env.AUTH_STATE.put(AUTH_STATE_KV_KEY, JSON.stringify(envelope));
  return updatedAt;
}

async function putAuthState(request: Request, env: WorkerEnv): Promise<Response> {
  if (!collectionModeEnabled(env)) return json({ error: "unsafe-deploy-mode" }, 503);
  if (!env.ADMIN_TOKEN) return json({ error: "admin-token-not-configured" }, 503);
  if (!env.AUTH_STATE_KEY) return json({ error: "auth-state-key-not-configured" }, 503);
  if (!(await authorized(request, env))) return json({ error: "not-found" }, 404);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return json({ error: "content-type-must-be-json" }, 415);
  }

  try {
    const storageState = validateStorageState(
      await readJsonLimited(request, MAX_AUTH_STATE_BYTES),
    );
    const updatedAt = await saveAuthState(env, storageState);
    return json(authStateMetadata(storageState, updatedAt));
  } catch (error) {
    return authStateFailure(error);
  }
}

async function getAuthStateStatus(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ error: "admin-token-not-configured" }, 503);
  if (!(await authorized(request, env))) return json({ error: "not-found" }, 404);
  try {
    const { storageState, updatedAt } = await loadAuthState(env);
    return json({ configured: true, ...authStateMetadata(storageState, updatedAt) });
  } catch (error) {
    if (error instanceof AuthStateError && error.code === "auth-state-not-configured") {
      return json({ configured: false });
    }
    return json({ error: "auth-state-unavailable" }, 503);
  }
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
          `INSERT INTO posts (
             id, handle, author_handle, author_name, url, body,
             published_at, discovered_at, is_reply, is_repost, media_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(handle, id) DO UPDATE SET
             author_handle = excluded.author_handle,
             author_name = excluded.author_name,
             url = excluded.url,
             body = excluded.body,
             published_at = excluded.published_at,
             is_reply = excluded.is_reply,
             is_repost = excluded.is_repost,
             media_json = excluded.media_json`,
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

async function runCollection(
  options: CollectionOptions,
  env: WorkerEnv,
): Promise<CollectionResult> {
  await seedAccounts(env.DB);
  const runId = options.scheduledKey
    ? `scheduled:${options.scheduledKey}`
    : crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const lease = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO collection_runs (
         id, started_at, status, requested_handles, scheduled_key
       ) VALUES (?, ?, 'running', ?, ?)`,
    )
    .bind(runId, startedAt, options.handles.length, options.scheduledKey ?? null)
    .run();
  if ((lease.meta.changes ?? 0) === 0) {
    return {
      runId,
      status: "duplicate",
      stored: 0,
      browserMs: 0,
      authStateUpdatedAt: null,
      authStateRefreshError: null,
      results: [],
    };
  }

  let stage = "auth-state-load";
  try {
    const { storageState } = await loadAuthState(env);
    stage = "browser-run";
    const result = await scrapeAccounts({
      binding: env.BROWSER,
      handles: options.handles,
      maxPostsPerHandle: options.maxPostsPerHandle,
      deadlineMs: options.deadlineMs,
      storageState,
    });
    let authStateUpdatedAt: string | null = null;
    let authStateRefreshError: string | null = null;
    stage = "auth-state-save";
    try {
      authStateUpdatedAt = await saveAuthState(env, result.updatedStorageState);
    } catch (error) {
      authStateRefreshError = error instanceof AuthStateError
        ? error.code
        : "auth-state-refresh-failed";
      console.warn(JSON.stringify({
        event: "auth-state-refresh-failed",
        runId,
        errorCode: authStateRefreshError,
      }));
    }
    stage = "post-store";
    const stored = await storePosts(
      env.DB,
      result.results.flatMap((entry) => entry.posts),
    );
    const failed = result.results.find((entry) => entry.errorCode);
    const finishedAt = new Date().toISOString();

    stage = "run-finalize";
    await env.DB.batch([
      ...result.results.map((entry) =>
        env.DB
          .prepare(
            `UPDATE accounts SET
               last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
               last_error_code = ?,
               avatar_url = COALESCE(?, avatar_url),
               updated_at = CURRENT_TIMESTAMP
             WHERE handle = ?`,
          )
          .bind(
            entry.errorCode ?? null,
            finishedAt,
            entry.errorCode ?? null,
            entry.avatarUrl ?? null,
            entry.handle,
          ),
      ),
      ...result.results.map((entry) =>
        env.DB
          .prepare(
            `INSERT INTO collection_run_results (
               run_id, handle, found_posts, avatar_present, error_code
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(run_id, handle) DO UPDATE SET
               found_posts = excluded.found_posts,
               avatar_present = excluded.avatar_present,
               error_code = excluded.error_code`,
          )
          .bind(
            runId,
            entry.handle,
            entry.posts.length,
            entry.avatarUrl ? 1 : 0,
            entry.errorCode ?? null,
          ),
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
          stored,
          result.browserMs,
          failed?.errorCode ?? null,
          runId,
        ),
    ]);

    return {
      runId,
      status: failed ? "failed" : "ok",
      stored,
      browserMs: result.browserMs,
      authStateUpdatedAt,
      authStateRefreshError,
      results: result.results.map((entry) => ({
        handle: entry.handle,
        found: entry.posts.length,
        avatarPresent: Boolean(entry.avatarUrl),
        errorCode: entry.errorCode ?? null,
      })),
    };
  } catch (error) {
    const diagnostic = error instanceof ScrapeInfrastructureError
      ? {
        stage: error.stage,
        sessionId: error.sessionId,
        errorName: error.originalName,
      }
      : {
        stage,
        sessionId: null,
        errorName: error instanceof Error ? error.name : "UnknownError",
      };
    console.error(JSON.stringify({
      event: "collection-run-failed",
      runId,
      ...diagnostic,
    }));
    const errorCode = error instanceof AuthStateError
      ? error.code
      : `run-failed:${diagnostic.stage}`;
    await env.DB
      .prepare(
        `UPDATE collection_runs SET
           finished_at = ?, status = 'failed', error_code = ?
         WHERE id = ?`,
      )
      .bind(new Date().toISOString(), errorCode, runId)
      .run();
    return {
      runId,
      status: "failed",
      stored: 0,
      browserMs: 0,
      authStateUpdatedAt: null,
      authStateRefreshError: null,
      results: [],
      error: "run-failed",
      diagnostic,
    };
  }
}

async function collect(request: Request, env: WorkerEnv): Promise<Response> {
  if (!collectionModeEnabled(env)) return json({ error: "unsafe-deploy-mode" }, 503);
  if (!env.ADMIN_TOKEN) return json({ error: "admin-token-not-configured" }, 503);
  if (!(await authorized(request, env))) return json({ error: "not-found" }, 404);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return json({ error: "content-type-must-be-json" }, 415);
  }

  let body: CollectRequest;
  try {
    const value = await readJsonLimited(request, 4_096);
    if (!isCollectRequest(value)) return json({ error: "invalid-request" }, 400);
    body = value;
  } catch (error) {
    return authStateFailure(error);
  }

  const maxHandles = positiveInt(env.MAX_HANDLES_PER_RUN, 1, accounts.length);
  const configuredMaxPosts = positiveInt(env.MAX_POSTS_PER_HANDLE, 10, 50);
  const parsed = parseCollectRequest(body, maxHandles, configuredMaxPosts);
  if (parsed instanceof Response) return parsed;
  const result = await runCollection({
    ...parsed,
    deadlineMs: positiveInt(env.RUN_DEADLINE_MS, 45_000, 45_000),
  }, env);
  return json(result, result.error ? 502 : 200);
}

async function scheduledCollection(
  controller: ScheduledController,
  env: WorkerEnv,
): Promise<void> {
  controller.noRetry();
  if (!scheduledMode(env)) throw new Error("Scheduled collection is not enabled.");
  const slot = scheduledSlot(
    controller.scheduledTime,
    env.SCHEDULE_TIME_ZONE,
    env.SCHEDULE_HOURS,
  );
  if (!slot) {
    console.log(JSON.stringify({
      event: "scheduled-collection-skipped",
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    }));
    return;
  }

  const result = await runCollection({
    handles: accounts.map((account) => account.handle),
    maxPostsPerHandle: positiveInt(env.MAX_POSTS_PER_HANDLE, 10, 10),
    deadlineMs: positiveInt(env.SCHEDULED_RUN_DEADLINE_MS, 300_000, 300_000),
    scheduledKey: slot.key,
  }, env);
  console.log(JSON.stringify({
    event: "scheduled-collection-finished",
    localSlot: slot.localLabel,
    runId: result.runId,
    status: result.status,
    stored: result.stored,
    browserMs: result.browserMs,
    results: result.results,
    diagnostic: result.diagnostic ?? null,
  }));
  if (result.status === "failed") throw new Error("Scheduled collection failed.");
}

async function feed(request: Request, env: WorkerEnv, handle?: string): Promise<Response> {
  const url = new URL(request.url);
  let title = "X feeds";
  let description = "Collected posts from configured X accounts";
  let homeUrl = "https://x.com/";
  let imageUrl: string | undefined;
  let rows: D1Result<StoredPostRow>;

  if (handle) {
    const account = configuredAccount(handle);
    if (!account) return json({ error: "not-found" }, 404);
    title = `${account.name} / @${account.handle}`;
    description = `Recent X posts collected for @${account.handle}`;
    homeUrl = `https://x.com/${account.handle}`;
    imageUrl = await env.DB
      .prepare(`SELECT avatar_url FROM accounts WHERE handle = ?`)
      .bind(account.handle)
      .first<string>("avatar_url") ?? undefined;
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
      homeUrl,
      imageUrl,
      posts: rows.results,
    }),
  );
}

async function health(env: WorkerEnv): Promise<Response> {
  const [latest, latestSuccess, postCount, authState] = await Promise.all([
    env.DB
      .prepare(
        `SELECT id, started_at, finished_at, status, requested_handles,
                collected_posts, browser_ms, error_code, scheduled_key
         FROM collection_runs ORDER BY started_at DESC LIMIT 1`,
      )
      .first(),
    env.DB
      .prepare(
        `SELECT id, started_at, finished_at, requested_handles,
                collected_posts, browser_ms, scheduled_key
         FROM collection_runs WHERE status = 'ok'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM posts`).first<number>("count"),
    env.AUTH_STATE.get<EncryptedAuthState>(AUTH_STATE_KV_KEY, "json"),
  ]);
  return json({
    ok: true,
    deployMode: env.DEPLOY_MODE,
    scheduled: scheduledMode(env),
    schedule: scheduledMode(env) ? {
      timeZone: env.SCHEDULE_TIME_ZONE,
      hours: env.SCHEDULE_HOURS.split(",").map(Number),
    } : null,
    configuredAccounts: accounts.length,
    storedPosts: postCount ?? 0,
    authStateUpdatedAt: authState?.updatedAt ?? null,
    latestRun: latest ?? null,
    latestSuccessfulRun: latestSuccess ?? null,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/admin/auth-state") {
      return putAuthState(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/collect") {
      return collect(request, env);
    }
    if (request.method === "GET" && url.pathname === "/admin/auth-state") {
      return getAuthStateStatus(request, env);
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
        name: "xfeeds-browser-canary",
        scheduled: scheduledMode(env),
        schedule: scheduledMode(env) ? {
          timeZone: env.SCHEDULE_TIME_ZONE,
          hours: env.SCHEDULE_HOURS.split(",").map(Number),
        } : null,
        feeds: ["/feeds/all.xml", ...accounts.map((a) => `/feeds/${a.handle}.xml`)],
      });
    }
    return json({ error: "not-found" }, 404);
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await scheduledCollection(controller, env);
  },
} satisfies ExportedHandler<WorkerEnv>;
