import type { CollectedPost } from "./model";

export interface RawPost {
  id: string;
  authorHandle: string;
  authorName: string;
  path: string;
  body: string;
  publishedAt: string;
  isReply: boolean;
  media: string[];
}

export function normalizeRawPost(
  targetHandle: string,
  raw: RawPost,
  discoveredAt: string,
): CollectedPost | undefined {
  if (!/^\d{5,30}$/.test(raw.id) || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+/.test(raw.path)) {
    return undefined;
  }
  const published = new Date(raw.publishedAt);
  if (Number.isNaN(published.valueOf())) return undefined;

  return {
    id: raw.id,
    handle: targetHandle,
    authorHandle: raw.authorHandle || targetHandle,
    authorName: raw.authorName || raw.authorHandle || targetHandle,
    url: `https://x.com${raw.path.split("?")[0]}`,
    body: raw.body.trim(),
    publishedAt: published.toISOString(),
    discoveredAt,
    isReply: raw.isReply,
    isRepost: raw.authorHandle.toLowerCase() !== targetHandle.toLowerCase(),
    media: [...new Set(raw.media)].slice(0, 4),
  };
}
