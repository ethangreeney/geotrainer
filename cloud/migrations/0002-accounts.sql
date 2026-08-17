-- 0002 — accounts + clue-card cache.
-- users gains a signup timestamp (NULL for the original single user, which is
-- fine: the signup rate limit only counts rows created in the last 24h).
-- cards is a permanent cache of learnablemeta.com clue payloads — meta notes
-- rarely change, so there is no TTL and one fetch serves every user forever.

ALTER TABLE users ADD COLUMN created_at TEXT;

CREATE TABLE IF NOT EXISTS cards (
  cache_key TEXT PRIMARY KEY, -- "<mapId>:<panoId>"
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
