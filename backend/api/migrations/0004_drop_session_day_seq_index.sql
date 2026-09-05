-- 旧版0003を適用済みのdevelop / productionでは、0003を書き換えてもINDEXは残る。
-- デプロイはマイグレーションがWorkerより先に走るため、day_seqを書かない旧Workerが
-- 既定値0を重ねる窓でもセッション作成を止めないよう、後続マイグレーションで必ず外す。
-- 上限の原子性は条件付きINSERTの1文が担う。day_seq列は、列へ書く版のWorkerがこの窓で
-- 動き続けても壊れず、ロールバックもできるよう互換列として残す。
DROP INDEX IF EXISTS ux_sessions_device_date_seq;
