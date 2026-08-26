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
   command immediately and approximately once per hour.

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

The earlier Cloudflare Worker/D1 experiment remains in `src/worker.ts`,
`src/scrape.ts`, `wrangler.jsonc`, and `migrations/`, but it is not involved in
the local workflow.

## Verification

```sh
npm run check
```

X has no stable public DOM contract, so selectors may need maintenance when its
site changes. Keep the collection rate modest and use this only for accounts and
content you are permitted to access.
