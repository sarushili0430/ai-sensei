-- 授業枠の確認と作成は条件付きINSERTの1文で行い、原子性をこの列へ依存させない。
-- デプロイはマイグレーションが先なので、ここでUNIQUE INDEXまで作ると、day_seqを
-- 書かない旧Workerが既定値0を重ねる窓で、その日2行目以降の作成がすべて失敗する。

-- SQLiteのADD COLUMNでNOT NULLを足すには既定値が要る。既存行を壊さず、まず0で埋める。
-- day_seqは表示にも枠判定にも使わないが、列へ書く版のWorkerが既に動いている環境でも
-- マイグレーション先行の窓とロールバックを壊さないよう、互換列として今回は残す。
ALTER TABLE sessions ADD COLUMN day_seq INTEGER NOT NULL DEFAULT 0;

-- 旧版0003を適用済みの環境と値の形を揃える。created_atが同じ行もidで順序を決め、
-- (created_at, id)の全順序で前にある行を数える。
UPDATE sessions
   SET day_seq = (
     SELECT COUNT(*)
       FROM sessions AS earlier
      WHERE earlier.device_id = sessions.device_id
        AND earlier.local_date = sessions.local_date
        AND (earlier.created_at < sessions.created_at
          OR (earlier.created_at = sessions.created_at AND earlier.id < sessions.id))
   );
