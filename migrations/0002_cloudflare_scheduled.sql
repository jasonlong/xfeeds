ALTER TABLE accounts ADD COLUMN avatar_url TEXT;

CREATE TABLE posts_scheduled (
  id TEXT NOT NULL,
  handle TEXT NOT NULL COLLATE NOCASE,
  author_handle TEXT NOT NULL COLLATE NOCASE,
  author_name TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  is_reply INTEGER NOT NULL DEFAULT 0 CHECK (is_reply IN (0, 1)),
  is_repost INTEGER NOT NULL DEFAULT 0 CHECK (is_repost IN (0, 1)),
  media_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (handle, id),
  FOREIGN KEY (handle) REFERENCES accounts(handle) ON DELETE CASCADE
);

INSERT INTO posts_scheduled (
  id, handle, author_handle, author_name, url, body, published_at,
  discovered_at, is_reply, is_repost, media_json
)
SELECT
  id, handle, author_handle, author_name, url, body, published_at,
  discovered_at, is_reply, is_repost, media_json
FROM posts;

DROP TABLE posts;
ALTER TABLE posts_scheduled RENAME TO posts;

CREATE INDEX posts_by_handle_published
  ON posts(handle, published_at DESC);
CREATE INDEX posts_by_published
  ON posts(published_at DESC);

ALTER TABLE collection_runs ADD COLUMN scheduled_key TEXT;
CREATE UNIQUE INDEX collection_runs_by_scheduled_key
  ON collection_runs(scheduled_key)
  WHERE scheduled_key IS NOT NULL;

CREATE TABLE collection_run_results (
  run_id TEXT NOT NULL,
  handle TEXT NOT NULL COLLATE NOCASE,
  found_posts INTEGER NOT NULL DEFAULT 0,
  avatar_present INTEGER NOT NULL DEFAULT 0 CHECK (avatar_present IN (0, 1)),
  error_code TEXT,
  PRIMARY KEY (run_id, handle),
  FOREIGN KEY (run_id) REFERENCES collection_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (handle) REFERENCES accounts(handle) ON DELETE CASCADE
);
