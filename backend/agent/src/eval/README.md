# プロンプト評価ハーネス

AIが人手なしでプロンプト改善ループを回すためのヘッドレス評価。鍵は `ANTHROPIC_API_KEY` 1本
だけで、LiveKit・Deepgram・音声・日次枠は使わない。

コマンドは **`backend/agent` で走らせる前提**で書いてある。

```bash
cd backend/agent
pnpm run eval list
pnpm run eval run --stage board --scenario all --locale all --trials 3
```

`--out` を省いたときの置き場(`backend/agent/eval-out/`)は `cli.ts` が
`import.meta.dirname` から引くので、リポジトリルートから
`node --experimental-strip-types backend/agent/src/eval/cli.ts list` と打っても同じ場所に落ちる。

## 1. 前提

<!-- 鍵・`pnpm --filter @ai-sensei/prompts generate`・agentの再起動は不要なこと -->

## 2. 基本ループ

<!-- baseline → プロンプト編集 → generate → run → report → 採用/revert -->

## 3. ジャッジの回し方と過適合への注意

<!-- Stage B -->

## 4. シナリオの増やし方

<!-- 失敗した試行JSON → シナリオ化 -->

## 5. tuner との関係

<!-- 試行JSONの envelopes を tuner の /debug へ貼る -->
