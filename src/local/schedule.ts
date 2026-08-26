import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logsDir, projectRoot } from "./paths";

const label = "com.xrss.collect";
const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(agentsDir, `${label}.plist`);

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plist(): string {
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const cli = path.join(projectRoot, "src", "local", "cli.ts");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(tsxCli)}</string>
    <string>${xml(cli)}</string>
    <string>publish</string>
    <string>--all</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(logsDir, "collect.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, "collect.error.log"))}</string>
</dict>
</plist>
`;
}

function bootout(): void {
  try {
    execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
  } catch {
    // It is fine if the job was not loaded.
  }
}

async function install(): Promise<void> {
  await mkdir(agentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await writeFile(plistPath, plist(), "utf8");
  bootout();
  execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
  console.log(`Installed ${label}; it publishes all configured accounts now and every 3600 seconds.`);
  console.log(`Logs: ${logsDir}`);
}

async function uninstall(): Promise<void> {
  bootout();
  await rm(plistPath, { force: true });
  console.log(`Uninstalled ${label}. Existing feeds, posts, and browser profile were kept.`);
}

if (process.argv[2] === "install") await install();
else if (process.argv[2] === "uninstall") await uninstall();
else throw new Error("Usage: npm run schedule:install | npm run schedule:uninstall");
