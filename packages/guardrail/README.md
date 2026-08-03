# @ai-sensei/guardrail

Workersとagentの両方から使う純関数群。**すべて副作用なし・依存なし**なので、
ユニットテストで仕様を固定できる。

| モジュール | 役割 |
| --- | --- |
| `topic-guard.ts` | 二重ガードの2枚目。LLMの出力を機械的に照合する |
| `math-speech.ts` | 日本語STTの数式読み上げを正規化する |
| `spaced-repetition.ts` | 翌日 → 3日後 → 7日後の予約と、通知文の生成 |
| `progress.ts` | 連続日数と「埋めた穴」のカウンタ |

## 二重ガード

プロンプトで縛るだけではLLMは範囲外に滑るので、サーバ側でも照合する
(handoff §4「ガードレールの実装」)。

```ts
const allowed = buildAllowedTopics(detectedTopicIds); // 写真の単元 + その前提
const verdict = checkQuestion({ topic_id, text }, allowed);
if (!verdict.ok) {
  // rejectionGuidance[verdict.reason] をプロンプトに添えて再生成させる
}
```

弾く理由は6つ。`rejectionGuidance` に再生成用の指示が対になって入っている。

| reason | 何を防ぐか |
| --- | --- |
| `malformed_topic_id` | IDの形が壊れている |
| `unknown_topic_id` | LLMがIDを捏造した(大学数学・他教科) |
| `topic_not_allowed` | カリキュラム内だが写真に写っていない単元 |
| `answer_leak` | **質問が答えを与えてしまっている**(このアプリの根幹) |
| `out_of_scope_wording` | 「ロピタルの定理」等、高校範囲外の語 |
| `text_topic_mismatch` | **IDは許可内だが、本文が別単元の話**(IDはLLMの自己申告なので信用しない) |
| `not_a_question` | 相づちだけで質問になっていない |

`filterHoleTopicIds()` はカルテ側にも同じ照合をかける。範囲外のタグが付くと、
復習の通知まで的外れになるため。

## 数式音声の正規化

「エックスのにじょう」→ `x^2`、「さんぶんのに」→ `2/3`。
**やりすぎないこと**を方針にしていて、普通の日本語を壊さないことをテストで固定している。
「かける」「わる」は数と数に挟まれているときだけ演算子にする(「時間をかける」を
`時間を×` にしてしまうと、カルテの材料そのものが壊れるため)。
文脈依存の補正(「ディー」が距離dか判別式Dか)は、写真文脈を持つLLM側の仕事。

## 間隔反復

`scheduleReviews(holeIds, completedAt)` が穴ごとに3件の予約を返す。
基準はUTCではなく**ローカル日付**(既定JST)で、通知は20:00に置く。
深夜0時台のセッションで「翌日」がずれないことをテストしている。

通知文は `buildReviewPrompt()`。後輩からのお願いの形で、責める語彙を使わない
(テストで語彙を禁止している)。

## 進捗カウンタ

`computeStreak()` は、**きのうまで続いていれば連続を生かす**。
朝いちばんにホームを開いたユーザーを毎日がっかりさせないため。
途切れるのは丸1日空いたときだけ。

`ProgressCounters` は `streak_days` / `filled_holes` / `open_holes` /
`last_session_date` の4つだけで、スコアに類するフィールドを持たない
(テストでキー一覧を固定している)。
