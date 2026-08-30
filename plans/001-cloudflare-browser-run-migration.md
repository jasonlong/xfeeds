# Plan 001: Move authenticated hourly X scraping to Cloudflare Browser Run

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This migration has a mandatory one-account feasibility gate. Do
> not add a cron trigger, upgrade the Cloudflare plan, disable the Mac job, or
> change subscriber URLs until that gate and the later shadow-run gate pass.
> If anything in "STOP conditions" occurs, stop and report; do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 469d4c2..HEAD -- README.md package.json wrangler.jsonc migrations src scripts test`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against live code before proceeding. A substantive
> mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (multi-day, because it includes a remote feasibility canary and shadow period)
- **Risk**: HIGH (X may reject Cloudflare's explicitly bot-identified browser traffic)
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `469d4c2`, 2026-08-27

## Recommendation

Use a single Cloudflare Worker with these bindings:

- Browser Run / `@cloudflare/playwright` for one Chromium session per collection run.
- Workers KV for Playwright `storageState`, encrypted before it is written.
- D1 for accounts, posts, run leases, run history, and feed queries.
- A Cron Trigger at `17 * * * *` after the canary succeeds.
- The existing Worker routes to serve `/feeds/<handle>.xml` and `/feeds/all.xml` directly.

Do **not** plan an hourly production rollout on Workers Free. Browser Run Free
includes 10 browser minutes per day, so 24 hourly runs must average no more than
25 seconds each. Workers Paid starts at $5/month, includes 10 Browser Run hours
per month, and charges $0.09 per additional browser hour. At 720 hourly runs,
the included Browser Run allowance supports an average of about 50 seconds per
run. Measure the real 13-account batch before deciding whether to run hourly,
every two hours, or accept a small overage.

Authoritative references (checked 2026-08-27):

- [Cloudflare Playwright storage state](https://developers.cloudflare.com/browser-run/playwright/)
- [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)
- [Browser Run FAQ, including bot identification](https://developers.cloudflare.com/browser-run/faq/)
- [Worker Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## Why this matters

The current production path depends on a logged-in Mac, a dedicated local
Chrome profile, launchd, local JSON state, Git commits, and GitHub Pages. Moving
the browser and schedule to Cloudflare removes the always-on Mac dependency and
lets the same Worker persist results and serve RSS. The migration must preserve
the existing 13 feeds, avatars, deduplication semantics, and authenticated X
session without exposing session cookies.

Cloudflare documents that Browser Run traffic is always identifiable as bot
traffic. A valid cookie state therefore does not guarantee that X will return a
usable timeline. The one-account remote canary is the first deliverable; failure
there means this architecture is not viable and no broader rollout should occur.

## Current state

- `README.md:3-21` describes the Mac as the authenticated execution host and
  GitHub Pages as the feed host.
- `wrangler.jsonc:11-29` deliberately limits Cloudflare to manual mode, one
  handle, a 45-second deadline, and an empty cron list:

  ```jsonc
  "vars": {
    "DEPLOY_MODE": "manual-only",
    "MAX_HANDLES_PER_RUN": "1",
    "MAX_POSTS_PER_HANDLE": "20",
    "RUN_DEADLINE_MS": "45000"
  },
  "triggers": { "crons": [] }
  ```

- `src/scrape.ts:121-125` creates a clean Cloudflare browser context without
  authenticated storage state:

  ```ts
  browser = await launch(options.binding);
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  });
  ```

- `src/scrape.ts:127-145` processes handles sequentially but only extracts the
  initially rendered tweets. It does not scroll or capture profile avatars.
- `src/local/browser.ts:25-27` proves the local profile contains an X
  `auth_token`; `src/local/browser.ts:97-129` is the behavioral reference for
  avatar extraction, scrolling, deduplication, and sorting.
- `src/worker.ts:118-215` couples collection to an authenticated HTTP request;
  there is no internal collection service callable by `scheduled()`.
- `src/worker.ts:142` uses a random run ID, which does not prevent duplicate
  processing when scheduled delivery occurs more than once.
- `migrations/0001_initial.sql:12-24` incorrectly makes `posts.id` and `url`
  globally unique. The local store correctly keys posts by `handle + id` at
  `src/local/store.ts:27-37`, allowing one repost to appear in multiple feeds.
- `migrations/0001_initial.sql:3-10` has no `avatar_url`, even though RSS
  rendering supports account artwork.
- `src/worker.ts:241-248` does not pass an avatar URL into `renderRss`.
- `scripts/verify-safe-config.mjs:8-28` intentionally rejects scheduled mode
  and KV. It must be replaced with production cost/scope checks, not deleted.
- Baseline on 2026-08-27: `npm run check` passes 10 tests; `npm audit --omit=dev`
  reports zero vulnerabilities.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm install` | exit 0 |
| Baseline | `npm run check` | safety check, typecheck, and all tests pass |
| Types | `npx wrangler types` | generated bindings types, exit 0 |
| D1 local migration | `npx wrangler d1 migrations apply xfeeds --local` | all migrations applied |
| Worker bundle | `npx wrangler deploy --dry-run` | bundle succeeds, no deployment |
| Remote identity | `npx wrangler whoami` | exact intended account is shown |
| Remote canary | `npx wrangler dev --remote` | Worker starts with remote Browser Run binding |
| Feed XML | `curl --fail --silent <worker-url>/feeds/almonk.xml \| xmllint --noout -` | exit 0 |

Do not put secret values directly in shell history or command arguments. Use
interactive `wrangler secret put` prompts and the protected auth-seeding CLI
specified below.

## Suggested executor toolkit

- Use the `cloudflare-deploy` guidance for Browser Run, Workers, Cron Triggers,
  D1, KV, and deployment safety.
- Use current Cloudflare documentation rather than assuming the checked-in
  package or Wrangler API is still current.
- Use Context7 for the exact installed `@cloudflare/playwright` storage-state
  types before editing browser-context code.

## Scope

**In scope**:

- `wrangler.jsonc`
- `package.json`, `package-lock.json`
- `migrations/0002_cloudflare_scheduled.sql` (create)
- `src/worker.ts`
- `src/scrape.ts`
- `src/auth-state.ts` (create)
- `src/timeline.ts` (create if needed to share extraction behavior)
- `src/model.ts`, `src/rss.ts` only where required by the D1/avatar changes
- `src/local/browser.ts`, `src/local/cli.ts` only for the auth-state seeding command
- `scripts/verify-safe-config.mjs`, `scripts/deploy-safe.mjs`
- `test/auth-state.test.ts` (create), `test/worker.test.ts` (create), and focused
  updates to existing scrape/RSS/storage tests
- `README.md`

**Out of scope**:

- Do not remove the local Playwright collector, launchd installer, or GitHub
  Pages output during implementation. They are the rollback path.
- Do not disable the installed Mac LaunchAgent before the shadow gate passes.
- Do not commit `.xrss/`, raw cookies, storage-state JSON, encryption keys,
  admin tokens, screenshots of authenticated pages, or trace recordings.
- Do not add browser-evasion flags or attempt to conceal Cloudflare's bot
  identification.
- Do not add GitHub API publishing from the Worker. Cloudflare should serve the
  migrated feeds directly; GitHub Pages remains a temporary fallback.
- Do not add Queues, Durable Objects, Workflows, R2, AI products, or custom
  domains unless a STOP condition forces a separate design decision.

## Git workflow

- Branch: `codex/cloudflare-browser-run`
- Match the repository's imperative commit style, for example:
  `Add encrypted Cloudflare auth state` and `Enable hourly collection`.
- Keep the cron-enabling commit separate so it can be reverted independently.
- Do not push, deploy, change billing plans, or open a PR without operator
  instruction.

## Steps

### Step 1: Establish a cost-safe Cloudflare canary environment

1. Run `npx wrangler whoami` and record the exact account **name and plan**, not
   credentials. Stop if the account cannot be unambiguously identified.
2. Keep the production cron list empty. Add a `canary` Wrangler environment or
   equivalent explicit config that has:
   - the Browser Run binding;
   - a D1 binding named `DB`;
   - a KV binding named `AUTH_STATE`;
   - `DEPLOY_MODE=manual-only`;
   - `MAX_HANDLES_PER_RUN=1`;
   - `MAX_POSTS_PER_HANDLE=10`;
   - `RUN_DEADLINE_MS=45000`;
   - current compatibility date and `nodejs_compat`.
3. Rename Cloudflare resources from the stale `xrss` name to `xfeeds` in new
   resources/config. Do not silently bind an existing unknown database.
4. Create D1/KV resources only after the operator approves the exact account.
5. Update generated Worker types with `npx wrangler types` and use those types
   instead of expanding the hand-written `Env` interface indefinitely.

**Verify**:

- `npm run check` exits 0.
- `npx wrangler deploy --env canary --dry-run` exits 0.
- `wrangler.jsonc` still has no production cron.
- `git grep -n 'REPLACE_WITH_D1_DATABASE_ID' wrangler.jsonc` returns no match
  only after a real, verified canary D1 resource has been created.

### Step 2: Add encrypted, rotatable Playwright storage state

Cloudflare officially supports passing Playwright `storageState` into
`browser.newContext` and persisting updated state in KV. Do not store the X
session as plaintext KV data.

1. Create `src/auth-state.ts` with small, separately testable functions:
   - parse and validate a Playwright storage-state object;
   - allow cookies/origins only for `x.com`, `.x.com`, `twitter.com`, and
     `.twitter.com`;
   - require at least one non-empty `auth_token` cookie;
   - reject unexpected top-level fields and payloads over 64 KiB;
   - encrypt/decrypt JSON with AES-GCM using Web Crypto;
   - version the KV envelope (`version`, `iv`, `ciphertext`, `updatedAt`) so
     future rotation is possible.
2. Store only the AES key in a per-Worker secret named `AUTH_STATE_KEY`. Store
   the encrypted envelope at KV key `x-auth-state:v1`. Keep `ADMIN_TOKEN` as a
   separate Worker secret.
3. Add `POST /admin/auth-state`, protected exactly like the existing hidden
   admin endpoint. It must validate the payload, encrypt it, write KV, and
   return metadata only (cookie count, allowed domains, timestamp). It must
   never return or log cookies, origins, plaintext, IV/ciphertext, or keys.
4. Add a local CLI command, e.g. `npm run auth:seed-cloudflare`, that:
   - opens the already-authenticated dedicated local profile using the existing
     keychain-compatible path;
   - obtains `context.storageState()` in memory;
   - filters/validates locally with the same schema;
   - sends it over HTTPS to the protected canary endpoint;
   - accepts the admin token through a prompt or environment variable and never
     writes state/token to disk or stdout.
5. At Cloudflare scrape start, fetch and decrypt KV state and create the context
   with `browser.newContext({ storageState, locale, viewport })`.
6. At successful scrape end, call `context.storageState({ indexedDB: true })`,
   validate, encrypt, and write it back to KV. KV may be eventually consistent
   across regions, but the next scheduled run is an hour later; never depend on
   immediate cross-region read-after-write. For the manual seed verification,
   wait/retry metadata for up to 60 seconds rather than exposing data.

**Verify**:

- `npm test -- test/auth-state.test.ts` passes tests for round trip, wrong key,
  missing auth cookie, unexpected domain, malformed JSON, and oversize payload.
- `git grep -n 'console\.' src/auth-state.ts` returns no matches; tests also spy
  on collection logging and confirm no cookie/storage-state fields are emitted.
- Seed response contains metadata only.
- A read-only admin status response can confirm state exists and its age without
  returning any state bytes.

### Step 3: Run the mandatory one-account Browser Run feasibility canary

1. Update `src/scrape.ts` to accept decrypted storage state and return updated
   state metadata without logging it.
2. Bring Cloudflare scraping to behavioral parity with
   `src/local/browser.ts:97-129`:
   - wait for visible tweets;
   - capture and validate the profile avatar URL;
   - scroll in bounded rounds to reach the requested post count;
   - deduplicate within the target account;
   - preserve stable sorting and existing normalization;
   - abort fonts/media and always close page, context, and browser in `finally`.
3. Extract the browser-side article-to-`RawPost` callback into
   `src/timeline.ts` if both local and Cloudflare implementations can use it
   without importing incompatible Playwright types. Otherwise keep thin
   adapters but share pure normalization/validation functions; do not force a
   leaky abstraction.
4. Deploy only the manual canary and collect `@almonk` with a limit of 10.
5. Repeat the canary three times over at least one hour. Record only:
   `browserMs`, post count, avatar present/absent, HTTP status, error code, and
   auth-state age. Never enable Browser Run session recording for authenticated X.

**Feasibility gate (all must pass)**:

- Three consecutive remote runs show an authenticated profile timeline.
- Each run returns at least 10 valid, current posts and the expected avatar.
- No login, challenge, consent, rate-limit, or suspicious-activity page appears.
- Browser/context close is confirmed and no Browser Run session remains active.
- The feed contains the same stable GUIDs and newest-post timestamp as the local
  feed for the same account (allowing for collection-time differences).
- Browser usage is visible in Cloudflare's Browser Run dashboard and matches
  recorded `browserMs` closely enough to budget.

If this gate fails, stop the migration. Cloudflare states Browser Run requests
are always identifiable as bots; do not attempt evasion. Keep the Mac scheduler.

### Step 4: Correct D1 semantics before multi-account collection

Add `migrations/0002_cloudflare_scheduled.sql` rather than rewriting an
already-committed migration:

1. Add `accounts.avatar_url TEXT`.
2. Rebuild `posts` so the primary key is `(handle, id)` and `url` is no longer
   globally unique. Preserve foreign keys, checks, data, and both feed indexes.
3. Add a unique nullable `scheduled_key` to `collection_runs`, or an equivalent
   lease table keyed by the scheduled hourly slot. This is the idempotency key
   for duplicate Cron delivery.
4. Update `storePosts` to upsert on `(handle, id)` and refresh mutable metadata
   without changing the original `discovered_at`.
5. Update account writes to persist validated avatars.
6. Before applying remotely, query whether the D1 database contains data. If it
   does, export/backup it and test the table rebuild locally against that data.

**Verify**:

- `npx wrangler d1 migrations apply xfeeds --local` exits 0.
- `PRAGMA foreign_key_check` returns no rows.
- A test inserts the same X status ID for two target handles and both rows remain.
- Repeating the same scheduled key performs no second collection/write.
- Existing feed-order query plans use `posts_by_handle_published` and
  `posts_by_published`, not a full table scan.

### Step 5: Separate collection orchestration from HTTP and add scheduling

1. Refactor `src/worker.ts` so `runCollection(options, env)` is an internal
   service called by both the protected manual endpoint and `scheduled()`.
2. The scheduled handler must:
   - derive a deterministic hourly `scheduled_key` from
     `controller.scheduledTime`;
   - acquire the D1 run lease before launching a browser;
   - request all enabled accounts from the checked-in list;
   - use one browser and one authenticated context;
   - isolate per-account errors and preserve successful accounts;
   - enforce a hard wall deadline below the 15-minute Cron limit;
   - close all resources in `finally`;
   - record browser time, per-account counts/errors, and final run status;
   - avoid immediate retries for auth-required, rate-limit, challenge, or quota
     errors; those need operator action or time, not another browser launch.
3. Start sequentially for behavioral safety. Only if the cost gate requires it,
   process at most 2-3 pages concurrently inside the same browser/context. Do
   not acquire multiple browser sessions; pages do not count as concurrent
   browsers, while extra sessions do.
4. Raise `MAX_HANDLES_PER_RUN` to 13 only in scheduled/production config. Keep
   the admin request body capped and configured-account validation intact.
5. Update `/health` and `/` to report scheduled mode, last success/error,
   auth-state age, browser time, and configured feed paths without secrets.
6. Pass `accounts.avatar_url` into `renderRss` for per-account feeds. Preserve
   current content type, caching, XML escaping, GUIDs, and image metadata.

**Verify**:

- `npm test` includes tests for manual/scheduled shared orchestration, duplicate
  run lease, partial account failure, auth-required, deadline exhaustion,
  browser close on every failure branch, and avatar-bearing RSS.
- Local scheduled endpoint returns an `ok` outcome with mocked browser/D1/KV.
- A second invocation with the same scheduled time launches no browser.
- `npm run check` exits 0.

### Step 6: Benchmark all 13 accounts and choose the billing/schedule envelope

1. With cron still empty, run three protected 13-account collections remotely.
2. Capture aggregate `browserMs`, per-account duration, failures, post counts,
   and Cloudflare dashboard browser-hour deltas. Do not capture page content or
   cookies in telemetry.
3. Use these gates:
   - Workers Free hourly requires average total browser time <=25 seconds/run.
   - Workers Paid's included 10 hours/month requires <=50 seconds/run average at
     720 runs/month.
   - If the run averages 50-120 seconds, recommend Workers Paid and estimate the
     small browser overage at `$0.09 × excess browser hours`.
   - If p95 exceeds 120 seconds or accounts regularly challenge/rate-limit,
     stop and reconsider a two-hour cadence or the entire migration.
4. Set a conservative Worker CPU limit in Wrangler after measuring actual CPU.
   Replace the obsolete 10 ms proof limit, but retain an explicit ceiling to
   prevent runaway bills.
5. Obtain explicit operator approval before changing from Workers Free to Paid.

**Verify**: Add a benchmark table to the PR/implementation notes with three run
IDs, durations, Cloudflare usage delta, proposed cadence, and estimated monthly
base/overage. It must contain no page data or credentials.

### Step 7: Enable the hourly cron behind updated safety checks

Only after Steps 3-6 pass and the operator approves the plan/cost:

1. Set production `DEPLOY_MODE=scheduled`, `MAX_HANDLES_PER_RUN=13`, the measured
   deadline, and `triggers.crons=["17 * * * *"]`. Cron is UTC; minute 17 is
   intentionally off the top of the hour while still running hourly.
2. Rewrite `scripts/verify-safe-config.mjs` to assert the **new** safety contract:
   - exact expected Worker, Browser Run, D1, and KV bindings;
   - exactly one hourly cron and no faster schedule;
   - maximum 13 handles and 20 posts per handle;
   - explicit CPU/deadline caps;
   - no unapproved products, custom routes, session recording, or extra browser
     bindings;
   - observability enabled without secret/body logging.
3. Change `scripts/deploy-safe.mjs` to require a new one-command approval value
   naming scheduled Cloudflare deployment. Do not reuse the old
   `workers-free-manual-only` approval string.
4. Deploy, then wait up to 15 minutes for cron propagation.
5. Confirm the first scheduled run through Cron Events, D1 run history, health,
   and Browser Run usage.

**Verify**:

- `npm run safety:check` prints the new scheduled safety contract and exits 0.
- `npx wrangler deploy --dry-run` exits 0 before the approved real deploy.
- Exactly one Cron Trigger is visible.
- First scheduled run has one D1 lease, 13 per-account results, closed browser,
  and no secrets in logs.

### Step 8: Shadow, cut over feed URLs, and retain rollback

1. Keep the Mac scheduler and GitHub Pages feeds running for a 24-48 hour shadow
   period while Cloudflare collects independently.
2. Compare every account feed on:
   - HTTP 200 and valid XML;
   - expected feed title/avatar;
   - newest post timestamp;
   - stable GUID set for the latest 20 items;
   - no feed older than two scheduled intervals;
   - no duplicate items for one handle and no missing shared repost across two
     target handles.
3. After two consecutive successful scheduled runs and a clean shadow window,
   switch reader subscriptions to the Worker URLs (or an explicitly approved
   custom domain). The Worker becomes the RSS host; do not make it push GitHub.
4. Only after subscriber cutover, run `npm run schedule:uninstall` on the Mac.
5. Keep local auth/profile code and the GitHub Pages snapshot intact for at least
   seven days as rollback. Update README with Cloudflare operation, auth rotation,
   health checks, cost monitoring, rollback, and new subscription URLs.

**Verify**:

- All 14 Cloudflare URLs return HTTP 200 and valid XML.
- `/health` shows a successful scheduled run less than two hours old.
- `launchctl print gui/$(id -u)/com.xrss.collect` reports the local job absent
  only after cutover approval.
- Git working tree is clean and `.xrss/` remains ignored.

### Step 9: Document authentication rotation and rollback

Document two runbooks in `README.md`:

1. **Rotate X auth**: run local `npm run auth`, seed Cloudflare through the
   protected command, verify metadata/one-handle canary, revoke the old state by
   overwriting KV, and never paste state into dashboard logs/issues.
2. **Rollback**: remove the cron from Wrangler and deploy; reinstall the local
   scheduler; point subscribers back to GitHub Pages if needed; keep D1 for
   diagnosis; close any active Browser Run sessions.

**Verify**: A reviewer unfamiliar with this session can follow both runbooks
without obtaining a raw cookie value or guessing a Cloudflare resource name.

## Test plan

- `test/auth-state.test.ts`: storage-state schema, allowed domains, required
  auth cookie, size limit, AES-GCM round trip, tamper/wrong-key rejection, safe
  metadata.
- `test/scrape.test.ts`: move/add pure timeline extraction tests for posts,
  reposts, replies, media, avatar validation, scrolling dedupe, login/challenge,
  and bounded deadline behavior. Network/browser calls remain mocked in unit tests.
- `test/worker.test.ts`: mocked D1/KV/browser tests for manual authorization,
  scheduled orchestration, deterministic lease, duplicate event, partial
  account failure, quota/auth permanent failure, and guaranteed close.
- `test/rss.test.ts`: D1-sourced avatar, stable self URL, combined/per-account
  query output, XML validity.
- Migration test: same status ID stored for two target handles; both feed queries
  return it; foreign-key check clean.
- Remote canary: one authenticated account only, three consecutive successes,
  no cron.
- Shadow integration: compare all 14 Cloudflare feeds with the current GitHub
  Pages feeds over 24-48 hours.

## Done criteria

- [ ] Mandatory Browser Run canary passes three consecutive authenticated runs.
- [ ] `npm run check` exits 0 with the new auth/orchestration/migration tests.
- [ ] `npm audit --omit=dev` reports no high/critical reachable vulnerability.
- [ ] `npx wrangler deploy --dry-run` exits 0.
- [ ] D1 uses `(handle, id)` identity and persists avatars.
- [ ] Auth state is encrypted in KV; only its key/admin token are Worker secrets.
- [ ] No cookie, storage state, key, or token appears in Git, logs, responses, or traces.
- [ ] Duplicate scheduled delivery launches no second browser.
- [ ] All-account benchmark has a documented cadence and approved cost envelope.
- [ ] Exactly one approved hourly cron is deployed.
- [ ] Two consecutive scheduled all-account runs succeed.
- [ ] All 14 Worker feeds return valid XML and current content.
- [ ] 24-48 hour shadow comparison passes before the Mac job is disabled.
- [ ] README contains auth rotation, monitoring, cost, cutover, and rollback runbooks.
- [ ] No files outside the in-scope list are modified, except generated Wrangler
  types/resource IDs explicitly required by the chosen config.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report back; do not improvise if:

- Cloudflare Browser Run reaches a login, challenge, consent, rate-limit, or
  empty-timeline page with valid storage state in any of three canary runs.
- X blocks Cloudflare's bot-identified traffic. Do not add evasion measures.
- Auth state includes unexpected domains, exceeds 64 KiB after filtering, cannot
  be encrypted/decrypted reliably, or appears in logs/responses.
- The target Cloudflare account or current billing plan is ambiguous.
- Any step would upgrade to Workers Paid without explicit operator approval.
- A remote D1 database contains data and no tested backup/table-rebuild path exists.
- One-account canary exceeds its 45-second cap consistently.
- Thirteen-account p95 exceeds 120 seconds, regularly misses accounts, or
  consumes more browser time than the approved envelope.
- Implementing the schedule requires another stateful product (Durable Objects,
  Queues, Workflows) not included in this plan.
- The checked-in Cloudflare Playwright version lacks the documented
  `storageState` behavior; confirm current package/docs before changing versions.
- The local fallback is unavailable before the Cloudflare shadow gate passes.

## Maintenance notes

- X DOM selectors are an external, unstable contract. Treat falling post counts
  or widespread `no-posts-visible` as a scraper incident, not an empty feed.
- X sessions can expire independently of code. Health must distinguish
  `auth-required` from selector/network failures so rotation is obvious.
- Browser Run state lives in an incognito context restored from storage state,
  not a persistent Chrome profile. Always persist state explicitly after a run.
- KV is eventually consistent. The hourly writer pattern tolerates this; do not
  later add rapid concurrent auth-state writers without stronger coordination.
- Review Browser Run and Workers pricing/limits before changing frequency or
  account count. The 25-second Free and 50-second Paid-included thresholds assume
  24 runs/day and 30 days/month.
- Preserve the local collector until Cloudflare has operated reliably long
  enough that the maintainer deliberately removes the rollback path.
