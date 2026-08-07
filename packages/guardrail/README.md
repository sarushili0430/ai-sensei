# @ai-sensei/guardrail

Workersとagentの両方から使う純関数群。**すべて副作用なし・依存なし**なので、
ユニットテストで仕様を固定できる。

| モジュール | 役割 |
| --- | --- |
| `topic-guard.ts` | 二重ガードの2枚目。LLMの出力を機械的に照合する |
| `speech.ts` | 音声正規化の入口。**科目でルールを切り替える** |
| `math-speech.ts` | 日本語STTの数式読み上げを正規化する(数学) |
| `english-grammar-speech.ts` | 文法用語のカタカナ読みを英字に戻す(英文法) |
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
| `unknown_topic_id` | LLMがIDを捏造した(大学数学・言語学・他教科) |
| `topic_not_allowed` | カリキュラム内だが写真に写っていない単元 |
| `answer_leak` | **質問が答えを与えてしまっている**(このアプリの根幹) |
| `out_of_scope_wording` | 「ロピタルの定理」「統語論」等、高校範囲外の語 |
| `text_topic_mismatch` | **IDは許可内だが、本文が別単元の話**(IDはLLMの自己申告なので信用しない) |
| `not_a_question` | 相づちだけで質問になっていない |

`filterHoleTopicIds()` はカルテ側にも同じ照合をかける。範囲外のタグが付くと、
復習の通知まで的外れになるため。

### 科目のまたぎ

1セッションは1科目。`allowedSubjects()` が許可リストの科目を返し、
本文からの単元推定(`text_topic_mismatch`)を**その科目の中だけ**で行う。
科目をまたいで推定すると「比較」「否定」「省略」のような
**どちらの科目にもある日本語**で取り違えが起き、まっとうな数学の質問
(「なんで距離と半径を比較して判定したんですか?」)が英文法と見なされて落ちる。
科目そのものの取り違えは、その手前の `topic_not_allowed` が弾く。

## 音声の正規化

入口は `normalizeSpeech(text, subject)` と `normalizeUserUtterances(messages, subject)`。
**科目でルールが切り替わる。**

- 数学: 「エックスのにじょう」→ `x^2`、「さんぶんのに」→ `2/3`。
  「かける」「わる」は数と数に挟まれているときだけ演算子にする(「時間をかける」を
  `時間を×` にしてしまうと、カルテの材料そのものが壊れるため)。
- 英文法: 「エスブイオーシー」→ `SVOC`、「トゥ不定詞」→ `to不定詞`、
  「現在完了系」→ `現在完了形`。生徒が口にした**英文そのもの**
  (「アイ ハブ ビーン トゥ キョウト」)は触らない。カタカナから英文を復元しても
  誤りが増えるだけで、このアプリが聞きたいのは音ではなく理由のほうだから。

どちらも **やりすぎないこと**を方針にしていて、普通の日本語を壊さないことを
テストで固定している。文脈依存の補正(「ディー」が距離dか判別式Dか)は、
写真文脈を持つLLM側の仕事。

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
