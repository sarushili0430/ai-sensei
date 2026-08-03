# prompts/

システムプロンプトとfew-shot。**Markdownが正**で、差分レビューできるようにここに置く。

| ファイル | 使う場所 | 役割 |
| --- | --- | --- |
| `photo_analysis.ja.md` | workers/api(Vision LLM) | ノート写真 → 単元検出・質問の種 |
| `kohai_conversation.ja.md` | agent(会話LLM) | 後輩ペルソナ + 会話中のガードレール |
| `question_types.few_shot.ja.md` | agent | 質問4型の文体をそろえるfew-shot |
| `karte_generation.ja.md` | agent(セッション終了時) | transcript → カルテJSON |
| `math_speech_hints.ja.md` | 両方 | 数式音声の補正ヒント(§4(d)) |

## TypeScriptからの読み込み

Workers/agentはファイルシステムを前提にできないため、Markdownを文字列定数へ変換した
`packages/prompts/src/generated.ts` を経由します。**手で編集しないこと。**

```bash
pnpm --filter @ai-sensei/prompts generate   # .md → generated.ts
```

`.md` を編集して再生成を忘れると `packages/prompts/src/generated.test.ts` が落ちます。

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

## 書くときの約束

プロンプトは仕様書です。以下はコードのガードレール(`@ai-sensei/guardrail`)と
**二重に**書きます。片方だけ直さないこと。

1. 答え・解き方・正解を言わない
2. 写真に写っていない話題に触れない(topic_idは許可リストから選ぶ)
3. 点数・評価語を使わない
4. パス(説明できない)を責めない
