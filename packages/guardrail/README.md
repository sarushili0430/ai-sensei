# @ai-sensei/guardrail

Workersとagentの両方から使う純関数群。**すべて副作用なし・依存なし**なので、
ユニットテストで仕様を固定できる。

| モジュール | 役割 |
| --- | --- |
| `topic-guard.ts` | 二重ガードの2枚目。LLMの出力を機械的に照合する |
| `latex-guard.ts` | 板書LaTeXのコマンド照合。描けない式を端末に送らない |
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

## 板書LaTeXの照合

`flutter_math_fork` はKaTeXのDart移植で、本家が通すコマンドを全部は描けない。
**描けないコマンドが端末に届くと、板書がその行だけ空白か例外になる。**

```ts
const verdict = checkBoardLatex(step.board.tex);
if (!verdict.ok) {
  // latexRejectionGuidance[verdict.reason] を添えて再生成させる
}
```

検証は三段構え(`docs/pivot_plan_v1.md` §3-6)で、**ここは②だけ**を持つ。

| 層 | どこ | 何を防ぐ |
| --- | --- | --- |
| ① 式テンプレート | プロンプト | 許可コマンドの誤った**組み合わせ方** |
| ② コマンドの照合 | **`latex-guard.ts`** | 移植版が**対応していない**コマンド |
| ③ KaTeXでの実パース | `backend/agent` | **構文の壊れ**(括弧の閉じ忘れ・引数の過不足) |

③をここに置かないのは、このパッケージの「外部依存なし」を壊さないため。
文字数の上限と多行環境(`align` 等)の禁止は `@ai-sensei/contract` の責務なので、重複して実装しない。

| reason | 何を防ぐか |
| --- | --- |
| `unknown_command` | **描画を実測していないコマンド**(`\ln` `\overline` `\left` など)。`\href` `\includegraphics` も副次的に落ちる |
| `text_in_math` | **数式の中の文章・日本語**。`\text{よって}` は tofu(黒い棒)になる。禁止ではなく**置き場所が違う**ので、理由を分けて `text` 要素に誘導する |
| `unknown_environment` | `pmatrix` / `cases` 以外の環境 |
| `unbalanced_environment` | `\begin` と `\end` が対応していない |
| `row_separator_outside_environment` | 環境の外の `\\` `&`。板書は**1手順=1行** |

**許可リストは実測でPNGを目視したものだけを入れる。** 「KaTeXのドキュメントに載っているから」で
足してはいけない。移植版が対応しているとは限らないというのが、この層が存在する理由そのもの。
未検証で保留しているもの(`\ln` `\overline` `\left` `\right`、3×3以上の行列、
3行以上の `cases`)は `latex-guard.ts` のコメントに一覧がある。

**逆向きのずれも起きる。** 実測したのに許可し忘れると、描ける式が再生成で捨てられ、
レイテンシと原価だけが増える。`latex-guard.test.ts` の `measuredFormulas` が
**実測した式と許可リストの突き合わせ**で、実測で式を足したらここにも足す。

指示(`latexRejectionGuidance`)は**行き先まで書く**。「表せないものは日本語で書くこと」で
終えると、LLMは `\text{よって}` を書き、次のターンで `text_in_math` に落ちて堂々巡りになる。
数式にできないものの行き先は、常に「`text` の板書として送る」に揃える。

**日本語は数式に入れない。** `\text{よって}` は KaTeX のフォントに日本語グリフが無いため
文字化けする。`\text` 系のコマンドだけでなく、`\mathrm{よって}` や裸のかな・漢字も
同じ理由で落とす(コマンド名の列挙では塞げないため、`tex` 全体を見ている)。

`\\` と `&` は **`pmatrix` / `cases` の内側でだけ**通す。無条件に弾くと行列も場合分けも落ち、
無条件に通すと1行のはずの板書が2行に割れる。

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
