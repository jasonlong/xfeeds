import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AccountAvatars = Record<string, string>;

export async function readAvatars(filePath: string): Promise<AccountAvatars> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Unsupported avatar store format: ${filePath}`);
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeAvatars(filePath: string, avatars: AccountAvatars): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(avatars, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}
