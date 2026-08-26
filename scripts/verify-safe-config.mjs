import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const failures = [];

if (config.workers_dev !== true) failures.push("workers_dev must be true");
if (config.routes) failures.push("custom routes are forbidden for the proof");
if (config.vars?.DEPLOY_MODE !== "manual-only") failures.push("DEPLOY_MODE must be manual-only");
if (config.vars?.MAX_HANDLES_PER_RUN !== "1") failures.push("MAX_HANDLES_PER_RUN must be 1");
if (config.vars?.RUN_DEADLINE_MS !== "45000") failures.push("RUN_DEADLINE_MS must be 45000");
if (config.limits?.cpu_ms !== 10) failures.push("Worker CPU limit must be 10ms");
if (config.browser?.binding !== "BROWSER") failures.push("exactly one BROWSER binding is required");
if (config.d1_databases?.length !== 1) failures.push("exactly one D1 database is required");
if (!Array.isArray(config.triggers?.crons) || config.triggers.crons.length !== 0) {
  failures.push("cron triggers must be explicitly empty");
}

for (const forbidden of [
  "ai",
  "durable_objects",
  "hyperdrive",
  "kv_namespaces",
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

console.log("Safe proof configuration: manual-only, one handle, 45s deadline, no cron.");
