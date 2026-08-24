-- 復習問題(ADR 0009)。板書を材料に作り、AIが採点する1問。
--
-- **holes には触らない。** 既存ユーザーの穴は読めるまま残す(移行期は
-- 「過去の穴」と「これからの復習問題」が両方見える)。同じテーブルへ相乗りさせない
-- 理由は、`holes.status = 'filled'` が「本人が言えたと申告した」の意味で、
-- 復習問題の「正解した」とは別の出来事だから。混ぜると computeProgress が出す数字が
-- どちらなのか読めなくなる。

CREATE TABLE IF NOT EXISTS practice_problems (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES users(device_id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  -- どの板書から作ったか。誤った問題が出たときに材料を引く唯一の手段。
  board_id   TEXT NOT NULL,
  topic_id   TEXT NOT NULL,
  question   TEXT NOT NULL,
  -- 正解。穴の `quiz` が持っていなかった欄で、採点はこれと突き合わせる。
  -- **生徒には返さない**(結果画面に答えを出すと「先輩に聞く」の導線が死ぬ)。
  answer     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 復習リストは古い順に並べる(放置されたものから声をかける)。
CREATE INDEX IF NOT EXISTS idx_practice_problems_device
  ON practice_problems (device_id, created_at);
-- **1セッションにつき1問**(ADR 0009)を、DBの側でも言い切る。
--
-- /complete の再送は `sessions.status` で弾いているが、agent が同時に2本投げた場合は
-- どちらも `open` を見て通りうる(D1 は文をまたいだトランザクションを張らない)。
-- UNIQUE にしておくと2本目の INSERT が落ち、その回は 500 → agent が再送 →
-- 今度は保存済みが見えて replay になる。**取りこぼしより二重通知のほうが痛い。**
CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_problems_session
  ON practice_problems (session_id);

CREATE TABLE IF NOT EXISTS practice_attempts (
  id          TEXT PRIMARY KEY,
  problem_id  TEXT NOT NULL REFERENCES practice_problems(id),
  answered_at TEXT NOT NULL,
  -- 生徒が書いた答え。テキスト入力なので本人の言葉がそのまま残り、
  -- 親レポートの引用(旧 kartes.said_well)の代わりになる。
  response    TEXT NOT NULL,
  -- `unclear` は「採点側が読めなかった」。incorrect へ倒すと、モデルの迷いが
  -- 通知の段数と文面(1日後の「まちがえた問題」)として生徒の記録に残る。
  verdict     TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'unclear')),
  -- 採点したモデル名。採点の質が落ちた期間を後から切り分けるために残す。
  graded_by   TEXT NOT NULL,
  -- 結果画面に出す先輩の一言。見出しだけでは不正解のときに次の一手が出ない。
  comment     TEXT
);

-- 「その問題の直近の判定」を引くのが復習リストと結果画面の両方で要る。
CREATE INDEX IF NOT EXISTS idx_practice_attempts_problem
  ON practice_attempts (problem_id, answered_at);

-- 復習問題の通知予約。
--
-- **review_schedules に相乗りさせない。** あちらは hole_id が NOT NULL + 外部キーで、
-- SQLite では制約を緩めるのにテーブルの作り直しが要る(稼働中の行を触ることになる)。
-- 穴の予約は穴の寿命が尽きるまで、そのまま別のテーブルで生かしておく。
CREATE TABLE IF NOT EXISTS practice_schedules (
  id           TEXT PRIMARY KEY,
  problem_id   TEXT NOT NULL REFERENCES practice_problems(id),
  -- reviewStepDays = [1, 3, 7] の添字。正解のときは 1 を予約しない(段は詰めない)。
  step         INTEGER NOT NULL CHECK (step IN (1, 2, 3)),
  scheduled_at TEXT NOT NULL,
  -- OneSignal の通知ID。
  --
  -- **取り消しには使わない。**作成時に決めた段は取り消さない方針なので
  -- (3日目に正解したから7日目を消す、はやらない)、外部IDは
  -- 「その通知がどれだったか」を後から突き合わせるためだけに持つ。
  external_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_practice_schedules_problem
  ON practice_schedules (problem_id);

-- 復習セッションの根拠を、穴から復習問題へ移す。
--
-- `sessions.hole_id` は残す(移行前に溜まった穴から「先輩に聞く」を選ぶ経路が
-- しばらく生きている)。同じ列に `prb_...` を混ぜると、ID の接頭辞でしか
-- どちらか分からない行ができるので、列を分ける。
ALTER TABLE sessions ADD COLUMN practice_problem_id TEXT;
