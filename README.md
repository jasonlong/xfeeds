# xfeeds

Generate RSS feeds from a fixed list of public X accounts using a local,
signed-in Chrome profile. The public feeds are served by GitHub Pages; browser
authentication and post history never leave this Mac.

## How it works

1. `npm run auth` opens Chrome normally with a dedicated profile for one
   interactive X login. Quit that Chrome window after login so the command can
   verify and save the session.
2. `npm run collect` reopens that profile headlessly, collects recent posts,
   merges them into a local JSON store, captures profile avatars as feed artwork,
   and writes RSS files to `docs/feeds/`.
3. `npm run feeds:publish` collects every configured account and pushes changed
   files from `docs/` to GitHub.
4. `npm run schedule:install` installs a macOS LaunchAgent that runs that publish
   command approximately once per hour.

Authentication data and post history live under `.xrss/` and are ignored by
Git. The scraper never reads or modifies your normal Chrome profile.

## Local proof

Requires Node 22+ and Google Chrome on macOS.

```sh
npm install
npm run auth
npm run collect -- --all
npm run serve
```

The login command deliberately does not attach browser automation while you
enter credentials; some X login controls reject automation-driven browsers.

Then subscribe to:

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

## Publishing

GitHub Pages publishes the `docs/` directory from `main`. The scheduled publish
command stages only `docs/`, creates a commit only when generated output changed,
and pushes it to `origin`. Never commit `.xrss/`; it holds the authenticated
browser profile and local post history.

The Cloudflare Worker/D1 canary remains separate from this publishing path. It
does not change the local collector, LaunchAgent, GitHub Pages URLs, or feed
history.

## Cloudflare Browser Run schedule

The experimental Worker collects all configured accounts every day at 7 a.m.,
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
- Workers Paid includes 10 browser hours per month before Browser Run overage.
  Based on the measured 11.46 seconds per account, the seven daily batches use
  about 9.4 browser hours in a 30-day month. Monitor the Browser Run dashboard
  because slow or failed runs can push usage over the included allowance.

See the current [Playwright storage-state documentation](https://developers.cloudflare.com/browser-run/playwright/),
[Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/), and
[pricing](https://developers.cloudflare.com/browser-run/pricing/) before running
the experiment.

### Cloudflare runbook

First verify the exact Cloudflare account and its Workers plan. Do not deploy if
the account is ambiguous or paid usage is not understood.

```sh
npx wrangler login
npx wrangler whoami
npm run check
npm run deploy:dry-run
```

The checked-in config uses Wrangler automatic provisioning for a canary-only D1
database and KV namespace. After verifying the account, deploy explicitly:

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

The Cloudflare commands load that file automatically. Seed the canary from the
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
`no-posts-visible` as a failed feasibility test. Do not add evasion behavior.
Keep the Mac scheduler and GitHub Pages feeds as a rollback path until at least
two consecutive scheduled all-account runs succeed and the feeds match during
a 24–48 hour shadow window.

## Verification

```sh
npm run check
```

X has no stable public DOM contract, so selectors may need maintenance when its
site changes. Keep the collection rate modest and use this only for accounts and
content you are permitted to access.
