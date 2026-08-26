import path from "node:path";

export const projectRoot = process.cwd();
export const stateDir = path.join(projectRoot, ".xrss");
export const browserProfileDir = path.join(stateDir, "browser-profile");
export const storePath = path.join(stateDir, "posts.json");
export const avatarsPath = path.join(stateDir, "avatars.json");
export const feedsDir = path.join(projectRoot, "docs", "feeds");
export const logsDir = path.join(stateDir, "logs");
