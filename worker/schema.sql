-- One row per class. state is the class's JSON state (see src/rules.js).
-- version and stamp implement the compare-and-write in src/index.js.
CREATE TABLE IF NOT EXISTS classes (
  key     TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  stamp   TEXT NOT NULL DEFAULT '',
  state   TEXT NOT NULL
);

-- Activity history: every sign-in, action, and refused attempt.
CREATE TABLE IF NOT EXISTS log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  time   TEXT NOT NULL,
  class  TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS log_class ON log (class, id);

-- Before every change, the class state as it was, so the instructor can restore any earlier point.
CREATE TABLE IF NOT EXISTS snapshots (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  time   TEXT NOT NULL,
  class  TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  state  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snap_class ON snapshots (class, id);

-- The attendance tool's tables (att_classes, att_marks, att_answers) were created here until 2026-10-05;
-- the tool has its own database since (RabbaniMaysam/attendance). The live database keeps the old copies, unused.
