export interface CollectedPost {
  id: string;
  handle: string;
  authorHandle: string;
  authorName: string;
  url: string;
  body: string;
  publishedAt: string;
  discoveredAt: string;
  isReply: boolean;
  isRepost: boolean;
  media: string[];
}

export interface StoredPostRow {
  id: string;
  handle: string;
  author_handle: string;
  author_name: string;
  url: string;
  body: string;
  published_at: string;
  discovered_at: string;
  is_reply: number;
  is_repost: number;
  media_json: string;
}

export interface ScrapeResult {
  handle: string;
  posts: CollectedPost[];
  errorCode?: string;
}
