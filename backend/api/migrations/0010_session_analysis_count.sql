-- 1セッションの中で、初回を含めて写真解析を何回使ったかを数える。
-- 追加写真は既存の analysesPerSessionSlot (= 5) の内側でだけ受け付ける。
--
-- **0009 ではなく 0010。** 持ち時間制(#149)が `0009_session_time_budget.sql` を
-- 取っており、同じ番号で2本並ぶと適用順がファイル名の辞書順まかせになる。
-- どちらも `sessions` に列を足すので、順序が読めない状態のまま本番へ出さない。
ALTER TABLE sessions ADD COLUMN analysis_count INTEGER NOT NULL DEFAULT 1;

-- 既存行も初回の解析枠を1回使ったものとして扱う。DEFAULT 1 が既存行にも入るため、
-- UPDATEは不要。復習も従来から解析日次枠の1行として数えていた挙動を変えない。
