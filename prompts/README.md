# prompts/

システムプロンプトとfew-shot。**Markdownが正**で、差分レビューできるようにここに置く。

ファイル名は `<id>.<locale>.md`。**言語ごとに別本**を持つ
([ADR 0005](../docs/adr/0005-locale-curricula.md))。

| id | 使う場所 | 役割 |
| --- | --- | --- |
| `photo_analysis` | backend/api(Vision LLM) | ノート写真 → 単元検出・質問の種 |
| `kohai_conversation` | agent(会話LLM) | 後輩ペルソナ + 会話中のガードレール |
| `question_types_few_shot` | agent | 質問4型の文体をそろえるfew-shot |
| `karte_generation` | agent(セッション終了時) | transcript → カルテJSON |
| `math_speech_hints` | 両方 | 数式音声の補正ヒント(§4(d)) |
| `senpai_board` | agent(授業モードの板書LLM) | 先輩ペルソナ + 板書JSON生成([ピボット計画 v1](../docs/pivot_plan_v1.md) §3) |

現在のロケールは `ja` と `en` の2つ。**id の数 × 2ロケール**が揃って
いないとテストが落ちる(片方だけ足すと、その言語のセッションだけ静かに
日本語へフォールバックする)。id を1つ足すたびに `.md` は2本増え、
`packages/prompts/src/index.ts` の `promptIds` にも足す。

日本語の本文に「英語で答えてください」を足す作りにはしない。足す作りだと
ペルソナも禁止事項も日本語のまま英語で言い直されるだけで、few-shot は
日本語の例文のままになる。**文体の見本がない状態**で英語を喋らせると、
後輩の口調ではなく試験官の口調に寄る。

## TypeScriptからの読み込み

Workers/agentはファイルシステムを前提にできないため、Markdownを文字列定数へ変換した
`packages/prompts/src/generated.ts` を経由します。**手で編集しないこと。**

```bash
pnpm --filter @ai-sensei/prompts generate   # .md → generated.ts
```

`.md` を編集して再生成を忘れると `packages/prompts/src/index.test.ts` が落ちます。

```ts
getPrompt("kohai_conversation", "en");        // 言語を指定して取り出す
conversationSystemPrompt(variables, "en");    // few-shot と音声ヒントも英語で同梱
boardLessonSystemPrompt(variables, "en");     // 先輩(板書)+ 音声ヒント
```

未対応の言語は黙って `ja` に落とします(ここで例外にすると、言語が1つ増えた
瞬間に会話が始まらなくなるため)。

## フロントマター

各ファイルの先頭に、埋め込み変数の一覧を持たせています。

```yaml
---
id: kohai_conversation
locale: ja
model_role: conversation
variables: [photo_summary, visible_work, allowed_topics, question_seeds, remaining_seconds]
---
```

`renderPrompt()` は `variables` に宣言されていない変数を渡すとエラーにし、
本文に残った未展開の `{{...}}` も検出します(プロンプトの穴埋め漏れは、
そのままLLMの範囲逸脱につながるため)。

**同じ id なら、ロケール間で `variables` を揃えること。** ずれていると
片方の言語だけ `renderPrompt` が落ちます(= その言語では会話が始まらない)。
テストで見ています。

## 書くときの約束

プロンプトは仕様書です。以下はコードのガードレール(`@ai-sensei/guardrail`)と
**二重に**書きます。片方だけ直さないこと。**言語ごとにも二重**です
(英語側だけ抜けると、海外のユーザーにだけ約束が破られる)。

| # | 約束 | |
| --- | --- | --- |
| 1 | ~~答え・解き方・正解を言わない~~ → **教える。そのあと教え返させる** | **2026-08-09 改正** |
| 2 | 写真に写っていない話題に触れない(topic_idは許可リストから選ぶ) | 維持 |
| 3 | 点数・評価語を使わない | 維持 |
| 4 | パス(説明できない)を責めない | 維持 |

### 1番目の改正について(2026-08-09)

家庭教師AIへのピボットで、**1番目だけが改正されました**
([ピボット計画 v1](../docs/pivot_plan_v1.md) §0「憲法の部分改正」)。
残る3つは無傷です。**この事実を知らずに「答えを教えない」に戻すと、製品が別物になります。**

> **答えを教える。そのあと、あなたに教え返してもらう。**

改正が及ぶ範囲は id ごとに違います。プロンプトを直すときは、まずどちらかを確かめること。

| id | 1番目の扱い |
| --- | --- |
| `senpai_board` | **改正後。** 教える。ただし教えっぱなしにせず、必ず説明してもらうところまで行く |
| `kohai_conversation` `question_types_few_shot` | **改正前のまま。** 後輩は分かっていない側なので、答えを教えることがそもそもできない |
| `photo_analysis` | **改正前のまま。** 解析器の出力は「何を教えるか」を決めるための材料で、ここに解答が入ると誤読が下流に固定される |
| `karte_generation` | 対象外(採点しない ≒ 約束3の側の話) |

`@ai-sensei/guardrail` の `containsAnswerLeak()` は**後輩の質問を見るための関数**で、
先輩の板書には当てません。板書側の二重書きの相手は別で、こちらです:

| プロンプトに書くこと | コード側の相手 |
| --- | --- |
| `speech` は120字以内・数式を読み上げない | `contract` の `boardSpeechMaxLength` と `speech` のLaTeX禁止 |
| 使ってよいLaTeXコマンドの一覧 | `guardrail` の `allowedLatexCommands` |
| 日本語は数式ではなく `text` 要素へ | `guardrail` の `text_in_math` |
| 1手順=1行(`\\` を使わない・多行環境を使わない) | `contract` の `tex` の正規表現 / `guardrail` の `row_separator_outside_environment` |
| 長い式は `=` の前で割って2手順にする | **コード側の相手がまだいない**(計画書 §3-6b。W2でNode側の幅推定を入れるまで、ここはプロンプトだけが守っている) |

差し込む定型句も本文と同じ言語で書きます(`(なし)` / `(none)`、
`後輩:` / `Kohai:`)。日本語が1行混ざると、そこだけ日本語で返ってきます。
