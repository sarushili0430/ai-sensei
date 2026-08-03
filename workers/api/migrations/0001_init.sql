-- ai-sensei D1 初期スキーマ
-- 匿名(デバイスID)運用。アカウント作成を要求しないため、users のキーは device_id。

CREATE TABLE IF NOT EXISTS users (
  device_id          TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  is_premium         INTEGER NOT NULL DEFAULT 0,
  premium_expires_at TEXT,
  rc_app_user_id     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES users(device_id),
  kind             TEXT NOT NULL CHECK (kind IN ('new', 'review')),
  status           TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  created_at       TEXT NOT NULL,
  completed_at     TEXT,
  -- 無料枠(1日1回)とstreakはローカル日付で数えるので、UTCとは別に持つ
  local_date       TEXT NOT NULL,
  photo_key        TEXT,
  topic_ids        TEXT NOT NULL DEFAULT '[]',
  hole_id          TEXT,
  duration_seconds INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_device_date ON sessions (device_id, local_date);
CREATE INDEX IF NOT EXISTS idx_sessions_device_status ON sessions (device_id, status);

CREATE TABLE IF NOT EXISTS kartes (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  device_id         TEXT NOT NULL REFERENCES users(device_id),
  created_at        TEXT NOT NULL,
  topic_ids         TEXT NOT NULL DEFAULT '[]',
  said_well         TEXT NOT NULL DEFAULT '[]',
  term_notes        TEXT NOT NULL DEFAULT '[]',
  followup_question TEXT
  -- 点数・正答率の列は置かない。数えるのは連続日数と埋めた穴だけ。
);

CREATE INDEX IF NOT EXISTS idx_kartes_device ON kartes (device_id, created_at);

CREATE TABLE IF NOT EXISTS holes (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES users(device_id),
  karte_id    TEXT NOT NULL REFERENCES kartes(id),
  topic_id    TEXT NOT NULL,
  -- `desc` はSQLの予約語なので description にする(アプリ側は desc)
  description TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  evidence    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('open', 'filled')),
  created_at  TEXT NOT NULL,
  filled_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_holes_device_status ON holes (device_id, status);

CREATE TABLE IF NOT EXISTS review_schedules (
  id           TEXT PRIMARY KEY,
  hole_id      TEXT NOT NULL REFERENCES holes(id),
  step         INTEGER NOT NULL CHECK (step IN (1, 2, 3)),
  scheduled_at TEXT NOT NULL,
  -- OneSignal の通知ID。穴が埋まったらこれで取り消す
  external_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_schedules_hole ON review_schedules (hole_id);
