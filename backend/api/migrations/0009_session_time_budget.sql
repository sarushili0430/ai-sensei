-- 日次上限を授業の本数から、実際に話した合計時間へ移す。
--
-- /start でその回の最長秒数を仮押さえし、/complete の duration_seconds で
-- 精算する。両者を持たないと、同時開始のときに未使用の同じ残高を二重に配れる。
ALTER TABLE sessions ADD COLUMN max_seconds INTEGER;

-- /complete が来ない回もトークンの寿命後に自動精算したことを記録する。
ALTER TABLE sessions ADD COLUMN quota_settled_at TEXT;

-- 移行前は無料・Premiumとも1回の最長が1200秒だった。
-- 開始済みの旧行だけを埋め、未開始行は /start が新しい配分を書けるよう NULL のままにする。
UPDATE sessions SET max_seconds = 1200 WHERE started_at IS NOT NULL;

-- 完了済みの旧行は duration_seconds がすでに実績の正本。
UPDATE sessions
   SET quota_settled_at = completed_at
 WHERE status = 'completed' AND completed_at IS NOT NULL;
