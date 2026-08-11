-- 自習室の滞在時間は、運営がリテンションを見るための日次指標としてだけ保存する。
-- アプリの進捗へ返すと「学習時間」という3つ目の数字が生まれ、設計上の約束
-- 「数えるのは連続日数と埋めた穴だけ」を破るので、セッションとは別の内部表に閉じる。
--
-- 1訪問1行は採用しない。自習室をよく使う人ほど行が青天井に増え、指標を得るために
-- D1の行数を使い続ける形になるため。ユーザー×ローカル日付を主キーにして合算すれば、
-- 行数は訪問回数ではなく利用日数にだけ比例し、日ごとの推移もそのまま集計できる。
--
-- デプロイはマイグレーションがWorkerより先に走る。これは新しい表を作るだけなので、
-- 適用直後も旧Workerは既存表をそのまま使え、ロールバックしても余った表が無害に残る。
-- 既存表へのNOT NULL追加や書き換えは行わない。
CREATE TABLE IF NOT EXISTS study_room_daily (
  device_id      TEXT NOT NULL REFERENCES users(device_id),
  local_date     TEXT NOT NULL,
  total_seconds  INTEGER NOT NULL CHECK (total_seconds BETWEEN 1 AND 64800),
  -- 学習データではなく配送用UUID。直前と同じ退室イベントの二重加算を止める。
  last_visit_id  TEXT NOT NULL,
  -- 端末時刻は信用せず、APIが受け取ったサーバ時刻を残す。
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (device_id, local_date)
);
