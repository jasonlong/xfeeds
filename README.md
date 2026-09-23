# xfeeds

Generate RSS feeds from a fixed list of public X accounts. The primary feeds
are served by a Cloudflare Worker, which collects posts with Browser Run and
stores them in D1. A local Chrome collector and GitHub Pages remain available
as a fallback.

## How it works

1. `accounts.json` defines the accounts served by the Worker.
2. Cloudflare Cron collects posts seven times a day in Eastern time. The Worker
   stores posts in D1 and serves RSS at `/feeds/<handle>.xml` and
   `/feeds/all.xml`.
3. Changes to the Worker or account list require a Worker deployment. Pushing
   to GitHub does not deploy it; see [Cloudflare operations](#cloudflare-operations).

Subscribe to the primary feeds at:

```text
https://xfeeds-browser-canary.jason-df8.workers.dev/feeds/stephenhaney.xml
https://xfeeds-browser-canary.jason-df8.workers.dev/feeds/vladmoroz.xml
https://xfeeds-browser-canary.jason-df8.workers.dev/feeds/all.xml
```

The Worker name still contains `canary` for URL continuity; it is the primary
feed service. Its authenticated X session is encrypted in Workers KV.

## Local GitHub Pages fallback

Requires Node 22+ and Google Chrome on macOS.

`npm run auth` opens Chrome normally with a dedicated profile for one
interactive X login. Quit that Chrome window after login so the command can
verify and save the session. `npm run collect` reopens that profile headlessly,
collects recent posts, merges them into a local JSON store, captures profile
avatars as feed artwork, and writes RSS files to `docs/feeds/`.

Authentication data and post history live under `.xrss/` and are ignored by
Git. The scraper never reads or modifies your normal Chrome profile.

```sh
npm install
npm run auth
npm run collect -- --all
npm run serve
```

The login command deliberately does not attach browser automation while you
enter credentials; some X login controls reject automation-driven browsers.

The fallback feeds are served from GitHub Pages:

```text
https://jasonlong.github.io/xfeeds/feeds/almonk.xml
https://jasonlong.github.io/xfeeds/feeds/all.xml
```

Useful collection options:

```sh
# Watch the browser while debugging
npm run collect -- --handle almonk --headed

# Limit the number scraped (maximum 50)
npm run collect -- --handle almonk --max-posts 10

# Collect and publish all configured accounts immediately
npm run feeds:publish
```

## Hourly task (macOS)

Only install the task after a manual collection succeeds:

```sh
npm run schedule:install
```

It uses launchd's `StartInterval=3600`, so it is roughly hourly rather than
exactly on the hour. Logs are written to `.xrss/logs/`.

```sh
npm run schedule:uninstall
```

Uninstalling removes only the LaunchAgent. It keeps cookies, stored posts,
generated feeds, and logs.

## GitHub Pages publishing

GitHub Pages publishes the `docs/` directory from `main`. The scheduled publish
command stages only `docs/`, creates a commit only when generated output changed,
and pushes it to `origin`. Never commit `.xrss/`; it holds the authenticated
browser profile and local post history.

This fallback uses a separate post store from the Cloudflare Worker.

## Cloudflare operations

The primary Worker collects all configured accounts every day at 7 a.m.,
9 a.m., 11 a.m., 1 p.m., 3 p.m., 5 p.m., and 7 p.m. America/New_York time.
Cloudflare Cron runs hourly in UTC, and the Worker performs an Eastern-time
check before launching the browser, so daylight-saving changes do not shift the
schedule. Duplicate Cron delivery is suppressed by a unique D1 lease.

Scheduled runs use one browser and one authenticated context, process accounts
sequentially, collect at most ten posts per account, and stop after five
minutes. The protected manual endpoint remains limited to one account and 45
seconds. Browser recording is disabled, the Worker has no custom route, and an
explicit 500-millisecond CPU ceiling remains in place.

The local seeding command exports only X/Twitter cookies and storage from the
dedicated Chrome profile. The Worker validates that state, requires an
`auth_token`, encrypts it with AES-256-GCM, and stores only the encrypted
envelope in Workers KV. The encryption key and admin token are separate Worker
secrets. Browser session recording is explicitly disabled.

Cloudflare documents two important constraints:

- Browser Run requests are always identified as bot traffic, so valid cookies
  do not guarantee that X will serve a timeline.
- Browser Run usage may incur charges. Monitor the Browser Run dashboard as the
  account list and collection times change.

See the current [Playwright storage-state documentation](https://developers.cloudflare.com/browser-run/playwright/),
[Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/), and
[pricing](https://developers.cloudflare.com/browser-run/pricing/) when changing
the collection schedule or account list.

### Deploying changes

Verify the Cloudflare account and its Workers plan before deploying. The
repository does not currently deploy the Worker automatically on git push.

```sh
npx wrangler login
npx wrangler whoami
npm run check
npm run deploy:dry-run
```

The checked-in config uses Wrangler automatic provisioning for its D1 database
and KV namespace. After verifying the account, deploy explicitly:

```sh
npx wrangler d1 migrations apply xfeeds-browser-canary --remote
XRSS_DEPLOY_APPROVED=workers-paid-seven-daily-et npm run deploy
```

Set both secrets through Wrangler's interactive prompt. `AUTH_STATE_KEY` must be
a base64 or base64url encoded 32-byte random key; keep it in a password manager
because losing it makes the encrypted session state unreadable.

```sh
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AUTH_STATE_KEY
```

Save the canary URL and admin token once in the git-ignored
`.env.cloudflare` file. The setup prompt does not echo the token and restricts
the file to your user account (mode `0600`):

```sh
npm run cloudflare:configure -- \
  --url https://xfeeds-browser-canary.<subdomain>.workers.dev
```

The Cloudflare commands load that file automatically. Seed the Worker from the
existing dedicated local X profile; exported cookies are never written to disk
or stdout:

```sh
npm run auth:seed-cloudflare
```

To populate every configured feed outside the schedule, use the local batch
command. It waits ten seconds between protected single-account Browser Run
requests:

```sh
npm run cloudflare:collect -- --all
```

The response reports post count, avatar presence, error code, and measured
browser duration; it never returns auth state. Treat `login-required`,
`auth-challenge`, `consent-required`, `rate-limited`, or repeated
`no-posts-visible` as a collection failure. Do not add evasion behavior.

## Verification

```sh
npm run check
```

X has no stable public DOM contract, so selectors may need maintenance when its
site changes. Keep the collection rate modest and use this only for accounts and
content you are permitted to access.
