import { spawnSync } from "node:child_process";
import process from "node:process";

if (process.env.XRSS_DEPLOY_APPROVED !== "workers-paid-seven-daily-et") {
  console.error(
    "Deployment blocked. Verify the target account is Workers Paid and the included usage is understood, then set " +
      "XRSS_DEPLOY_APPROVED=workers-paid-seven-daily-et for this command only.",
  );
  process.exit(1);
}

const safety = spawnSync(process.execPath, ["scripts/verify-safe-config.mjs"], {
  stdio: "inherit",
});
if (safety.status !== 0) process.exit(safety.status ?? 1);

const deploy = spawnSync("npx", ["wrangler", "deploy"], {
  stdio: "inherit",
  shell: false,
});
process.exit(deploy.status ?? 1);
