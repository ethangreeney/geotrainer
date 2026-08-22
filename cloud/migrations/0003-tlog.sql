-- 0003 — userscript debug log.
-- The Tampermonkey script ships its own console lines home every ~10s, so a
-- silent capture failure on the gaming PC is diagnosable instead of invisible.
-- This is a tail, not an archive: the intake prunes each user back to the
-- newest few hundred rows on every write.

CREATE TABLE IF NOT EXISTS tlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts INTEGER NOT NULL, -- epoch ms, as the client saw it
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tlog_user_ts ON tlog (user_id, ts);
