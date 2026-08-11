-- 授業枠の確認と作成を条件付きINSERTの1操作にし、同時実行でも1日上限を超えさせない。
-- 条件付きINSERTが判定を持つが、スキーマ側にも「同じ日の同じ枠は1行」を残す。
-- コードの書き換えで数え直しが戻ってきても、DBが同じ枠の二重取りを拒むため。

-- SQLiteのADD COLUMNでNOT NULLを足すには既定値が要る。既存行を壊さず、まず0で埋める。
ALTER TABLE sessions ADD COLUMN day_seq INTEGER NOT NULL DEFAULT 0;

-- 採番が重複するとUNIQUE INDEXの作成でマイグレーションが止まる。
-- created_atが同じ行もidで順序を決め、(created_at, id)の全順序で前にある行を数える。
UPDATE sessions
   SET day_seq = (
     SELECT COUNT(*)
       FROM sessions AS earlier
      WHERE earlier.device_id = sessions.device_id
        AND earlier.local_date = sessions.local_date
        AND (earlier.created_at < sessions.created_at
          OR (earlier.created_at = sessions.created_at AND earlier.id < sessions.id))
   );

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_device_date_seq
  ON sessions (device_id, local_date, day_seq);
