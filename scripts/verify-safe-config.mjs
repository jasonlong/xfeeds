import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const scrapeSource = await readFile(new URL("../src/scrape.ts", import.meta.url), "utf8");
const failures = [];

if (config.workers_dev !== true) failures.push("workers_dev must be true");
if (config.name !== "xfeeds-browser-canary") failures.push("Worker must use the canary name");
if (config.routes) failures.push("custom routes are forbidden for the proof");
if (config.vars?.DEPLOY_MODE !== "scheduled-daily-et") {
  failures.push("DEPLOY_MODE must be scheduled-daily-et");
}
if (config.vars?.MAX_HANDLES_PER_RUN !== "1") failures.push("MAX_HANDLES_PER_RUN must be 1");
if (config.vars?.MAX_POSTS_PER_HANDLE !== "10") failures.push("MAX_POSTS_PER_HANDLE must be 10");
if (config.vars?.RUN_DEADLINE_MS !== "45000") failures.push("RUN_DEADLINE_MS must be 45000");
if (config.vars?.SCHEDULED_RUN_DEADLINE_MS !== "300000") {
  failures.push("SCHEDULED_RUN_DEADLINE_MS must be 300000");
}
if (config.vars?.SCHEDULE_TIME_ZONE !== "America/New_York") {
  failures.push("SCHEDULE_TIME_ZONE must be America/New_York");
}
if (config.vars?.SCHEDULE_HOURS !== "7,9,11,13,15,17,19") {
  failures.push("SCHEDULE_HOURS must contain the seven approved daytime slots");
}
if (config.limits?.cpu_ms !== 500) failures.push("Worker CPU limit must be 500ms");
if (config.browser?.binding !== "BROWSER") failures.push("exactly one BROWSER binding is required");
if (config.d1_databases?.length !== 1) failures.push("exactly one D1 database is required");
if (config.d1_databases?.[0]?.binding !== "DB") failures.push("the D1 binding must be DB");
if (config.d1_databases?.[0]?.database_name !== "xfeeds-browser-canary") {
  failures.push("the D1 database must use the canary name");
}
if (config.kv_namespaces?.length !== 1 || config.kv_namespaces[0]?.binding !== "AUTH_STATE") {
  failures.push("exactly one AUTH_STATE KV binding is required");
}
if (
  !Array.isArray(config.triggers?.crons) ||
  config.triggers.crons.length !== 1 ||
  config.triggers.crons[0] !== "0 * * * *"
) {
  failures.push("exactly one hourly cron trigger is required");
}
if (config.observability?.enabled !== true || config.observability?.head_sampling_rate !== 1) {
  failures.push("full Worker observability must remain enabled");
}
if (!scrapeSource.includes("recording: false")) failures.push("browser recording must stay disabled");

for (const forbidden of [
  "ai",
  "durable_objects",
  "hyperdrive",
  "queues",
  "r2_buckets",
  "services",
  "workflows",
]) {
  if (config[forbidden]) failures.push(`${forbidden} is forbidden for the proof`);
}

if (failures.length > 0) {
  console.error(`Unsafe Cloudflare configuration:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  "Safe scheduled configuration: seven Eastern slots, hourly DST check, one browser, 10 posts/account, 5m deadline.",
);
