-- 計画は授業セッションと同じLiveKitを使うが、授業回数・連続日数には数えない。
-- 稼働中のsessions.kindのCHECKを広げるにはテーブル再作成が必要で、migration先行の
-- デプロイ窓に旧Workerが新しい形を知らず動く。既存表を一切変えない専用表なら、
-- 新旧どちらのWorkerも同時に安全で、授業と計画の集計も混ざらない。

CREATE TABLE IF NOT EXISTS study_plans (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE REFERENCES users(device_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('senpai', 'template')),
  intake TEXT NOT NULL,
  days TEXT NOT NULL,
  revisions TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES users(device_id),
  locale TEXT NOT NULL CHECK (locale IN ('ja', 'en')),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  duration_seconds INTEGER,
  plan_id TEXT REFERENCES study_plans(id)
);

-- completeの再送とユーザー単位の追跡に使う。既存表への後付け制約は作らない。
CREATE INDEX IF NOT EXISTS idx_plan_sessions_device_created
  ON plan_sessions(device_id, created_at DESC);
