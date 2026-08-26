import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CollectedPost, StoredPostRow } from "../model";

interface LocalStore {
  version: 1;
  posts: CollectedPost[];
}

export async function readPosts(filePath: string): Promise<CollectedPost[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (
      typeof parsed !== "object" || parsed === null ||
      !("version" in parsed) || parsed.version !== 1 ||
      !("posts" in parsed) || !Array.isArray(parsed.posts)
    ) {
      throw new Error(`Unsupported local store format: ${filePath}`);
    }
    return parsed.posts as CollectedPost[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function mergePosts(
  existing: CollectedPost[],
  collected: CollectedPost[],
  limit = 5_000,
): CollectedPost[] {
  const key = (post: CollectedPost) => `${post.handle.toLowerCase()}:${post.id}`;
  const byId = new Map(existing.map((post) => [key(post), post]));
  for (const post of collected) byId.set(key(post), post);
  return [...byId.values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}

export async function writePosts(filePath: string, posts: CollectedPost[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const value: LocalStore = { version: 1, posts };
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export function toStoredRow(post: CollectedPost): StoredPostRow {
  return {
    id: post.id,
    handle: post.handle,
    author_handle: post.authorHandle,
    author_name: post.authorName,
    url: post.url,
    body: post.body,
    published_at: post.publishedAt,
    discovered_at: post.discoveredAt,
    is_reply: post.isReply ? 1 : 0,
    is_repost: post.isRepost ? 1 : 0,
    media_json: JSON.stringify(post.media),
  };
}
