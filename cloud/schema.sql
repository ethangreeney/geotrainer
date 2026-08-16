-- GeoCoach cloud schema. Multi-tenant from day one: every row is scoped to a
-- user, even while there is exactly one. The state blob mirrors coach/state.json
-- minus `rounds`, which live in their own table so the blob can't grow unbounded
-- and each round can carry its own R2 assets later.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  name TEXT,
  config TEXT NOT NULL DEFAULT '{}' -- trainerMapId, sourceMaps, lmApiToken
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
