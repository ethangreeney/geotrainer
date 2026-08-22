-- GeoCoach cloud schema. Multi-tenant from day one: every row is scoped to a
-- user, even while there is exactly one. The state blob mirrors coach/state.json
-- minus `rounds`, which live in their own table so the blob can't grow unbounded
-- and each round can carry its own R2 assets later.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  name TEXT,
  config TEXT NOT NULL DEFAULT '{}', -- trainerMapId, sourceMaps, lmApiToken
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS states (
  user_id INTEGER PRIMARY KEY,
  json TEXT NOT NULL -- {countries, confusions, metas, deckCards, lastDeck}
);

CREATE TABLE IF NOT EXISTS rounds (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  dup_key TEXT NOT NULL,
  ts TEXT NOT NULL,
  answer_code TEXT,
  json TEXT NOT NULL,
  -- pre-grade snapshot for /rate overrides: {metaName, ts, padding, prevCard, prevMeta}
  snapshot TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS rounds_dup ON rounds (user_id, dup_key);
CREATE INDEX IF NOT EXISTS rounds_answer ON rounds (user_id, answer_code);

-- Clue cards fetched from learnablemeta.com, cached forever (meta notes rarely
-- change) and shared across users — one fetch per pano for the whole instance.
CREATE TABLE IF NOT EXISTS cards (
  cache_key TEXT PRIMARY KEY, -- "<mapId>:<panoId>"
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- The userscript's debug lines, shipped home so a silent capture failure is
-- diagnosable. A tail, not an archive: the intake prunes each user back to the
-- newest few hundred rows on every write.
CREATE TABLE IF NOT EXISTS tlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts INTEGER NOT NULL, -- epoch ms, as the client saw it
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tlog_user_ts ON tlog (user_id, ts);
