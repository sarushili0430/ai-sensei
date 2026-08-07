# prompts/

システムプロンプトとfew-shot。**Markdownが正**で、差分レビューできるようにここに置く。

| ファイル | 使う場所 | 役割 |
| --- | --- | --- |
| `photo_analysis.ja.md` | backend/api(Vision LLM) | ノート写真 → **科目判定**・単元検出・質問の種 |
| `kohai_conversation.ja.md` | agent(会話LLM) | 後輩ペルソナ + 会話中のガードレール |
| `karte_generation.ja.md` | agent(セッション終了時) | transcript → カルテJSON |

科目ごとに差し替えるものが2種類ある。**会話とカルテの組み立てで、科目に応じた対を選ぶ。**

| 科目 | 質問4型のfew-shot | 音声補正ヒント(§4(d)) |
| --- | --- | --- |
| 数学 | `question_types.math.few_shot.ja.md` | `math_speech_hints.ja.md` |
| 英文法 | `question_types.english_grammar.few_shot.ja.md` | `english_grammar_speech_hints.ja.md` |

科目を足すときは、この2ファイルを対で足し、`packages/prompts/src/index.ts` の
`promptIds` と `subjectPrompts` に登録する(片方だけだとテストで落ちる)。

## TypeScriptからの読み込み

Workers/agentはファイルシステムを前提にできないため、Markdownを文字列定数へ変換した
`packages/prompts/src/generated.ts` を経由します。**手で編集しないこと。**

```bash
pnpm --filter @ai-sensei/prompts generate   # .md → generated.ts
```

`.md` を編集して再生成を忘れると `packages/prompts/src/index.test.ts` が落ちます。

## フロントマター

各ファイルの先頭に、埋め込み変数の一覧を持たせています。

```yaml
---
id: kohai_conversation
locale: ja
model_role: conversation
variables: [subject, photo_summary, visible_work, allowed_topics, question_seeds, remaining_seconds]
---
```

`renderPrompt()` は `variables` に宣言されていない変数を渡すとエラーにし、
本文に残った未展開の `{{...}}` も検出します(プロンプトの穴埋め漏れは、
そのままLLMの範囲逸脱につながるため)。

## 書くときの約束

プロンプトは仕様書です。以下はコードのガードレール(`@ai-sensei/guardrail`)と
**二重に**書きます。片方だけ直さないこと。

1. 答え・解き方・正解を言わない(英文法なら、正しい語形と訳も言わない)
2. 写真に写っていない話題に触れない(topic_idは許可リストから選ぶ)
3. **今日の科目から出ない**(1セッションは1科目)
4. 点数・評価語を使わない
5. パス(説明できない)を責めない
