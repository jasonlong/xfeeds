PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  handle TEXT PRIMARY KEY COLLATE NOCASE,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_success_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL COLLATE NOCASE,
  author_handle TEXT NOT NULL COLLATE NOCASE,
  author_name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  is_reply INTEGER NOT NULL DEFAULT 0 CHECK (is_reply IN (0, 1)),
  is_repost INTEGER NOT NULL DEFAULT 0 CHECK (is_repost IN (0, 1)),
  media_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (handle) REFERENCES accounts(handle) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS posts_by_handle_published
  ON posts(handle, published_at DESC);
CREATE INDEX IF NOT EXISTS posts_by_published
  ON posts(published_at DESC);

CREATE TABLE IF NOT EXISTS collection_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  requested_handles INTEGER NOT NULL,
  collected_posts INTEGER NOT NULL DEFAULT 0,
  browser_ms INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS collection_runs_by_started
  ON collection_runs(started_at DESC);
