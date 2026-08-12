-- 1日の回数を数える位置を「写真を読んだとき」から「会話が始まったとき」へ移す。
--
-- それまでは行が在ること自体が「今日の1回を使った」証拠だった。撮って単元を
-- 確かめただけで枠が消え、会話を1度もしないまま「今日はここまで」になっていた。
-- これからは started_at が入った行だけを数える(POST /v1/sessions/{id}/start)。
ALTER TABLE sessions ADD COLUMN started_at TEXT;

-- 既存の行は「会話が始まったもの」として埋める。この列が無かった頃は、
-- 行が在ること = 枠を使ったこと だったので、NULLのまま残すと過去の行が
-- 全部「まだ始めていない」に化け、その日の枠が復活してしまう。
UPDATE sessions SET started_at = created_at WHERE started_at IS NULL;

-- 数えるのは (device_id, local_date, started_at IS NOT NULL) の3つ。
-- 既存の idx_sessions_device_date で前2つに乗り、残りは行数ぶんの判定なので
-- 新しいINDEXは足さない(1日あたり数行しか無い)。
