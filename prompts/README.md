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

現在のロケールは `ja` と `en` の2つ。**5つ × 2ロケール = 10ファイル**が揃って
いないとテストが落ちる(片方だけ足すと、その言語のセッションだけ静かに
日本語へフォールバックする)。

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
(英語側だけ抜けると、海外のユーザーにだけ答えを教える後輩ができあがる)。

1. 答え・解き方・正解を言わない
2. 写真に写っていない話題に触れない(topic_idは許可リストから選ぶ)
3. 点数・評価語を使わない
4. パス(説明できない)を責めない

差し込む定型句も本文と同じ言語で書きます(`(なし)` / `(none)`、
`後輩:` / `Kohai:`)。日本語が1行混ざると、そこだけ日本語で返ってきます。
