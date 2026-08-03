# ADR 0002: agentの言語をTypeScript(Node)にする

- ステータス: 承認
- 日付: 2026-08-03
- 関連: `docs/handoff_to_opus.md` §5・§9-6(残っていた未決事項)

## 背景

リアルタイム会話は LiveKit Agents に乗せると決めていたが、**実装言語がNodeかPythonか**が
未決だった(handoff §9-6)。LiveKit Agents は両方にSDKがあり、必要なプラグイン
(Silero VAD / Deepgram STT / Anthropic LLM / ElevenLabs TTS)も両方に揃っている。

## 決定

**TypeScript(Node 22)を採用する。**

理由:

1. **共有パッケージをそのまま使える。** ガードレール照合(`@ai-sensei/guardrail`)・
   カリキュラムマップ・プロンプト・契約スキーマは、backend/api と agent の**両方**で
   使う。Pythonにするとこれらを二重実装することになり、ソロ開発では確実に片方が腐る。
   特にガードレールは「プロンプトとコードの二重ガード」の要なので、実装がずれると意味を失う。
2. **カルテの契約が壊れない。** `karteDraftSchema` でLLMの出力を検証してから
   `/complete` へ送る流れが、workers側と同じzodスキーマで書ける。
3. モノレポのCI・型検査・テストが1系統で済む(Python向けにlint/テスト基盤を足さない)。

Pythonの利点(音声処理ライブラリの厚み・LiveKit公式サンプルの多さ)は認識しているが、
MVPの範囲では**プラグインを差し込むだけ**でカスタムDSPを書かないため、効いてこない。

## デプロイ

第一候補は **LiveKit Cloud のエージェントホスティング**。可否の確認は別タスク
(§9-6の後半)として残す。不可の場合は、Node 22のコンテナを常駐させる
(`node --experimental-strip-types src/index.ts start`)。どちらでも
`backend/agent/` ディレクトリの中身は変わらない。

## 結果

- 良い点: ガードレール・プロンプト・契約が1つの実装で、workers と agent の両方に効く。
- 良い点: `.ts` を直接実行できるので、ビルド手順を持たずに済む(Node 22の型ストリップ)。
- 悪い点: LiveKit Agents のNode SDKはPython版より新しく、事例が少ない。
  APIの破壊的変更を踏む可能性があるので、バージョンは `^1.6.1` で固定して追従する。
- 悪い点: Silero VAD の ONNX ランタイムがNode環境に依存する。ホスティング先が
  決まった時点で、`prewarm` が通ることを最初に確認する。
