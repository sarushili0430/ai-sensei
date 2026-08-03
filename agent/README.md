# @ai-sensei/agent

後輩AIの会話パイプライン。LiveKit Agents(Node)に乗せる。

```
VAD(Silero) → 日本語ストリーミングSTT(Deepgram) → Claude(後輩ペルソナ)
→ ElevenLabs TTS。割り込みと相づちはフレームワーク側。
```

**WebRTCは書かない。** ここで書くのは3つだけ:

1. 写真文脈の受け渡し(LiveKitトークンのmetadata → プロンプト)
2. 上限時間での打ち切り(サーバが決めた `max_seconds`)
3. セッション終了時のカルテ生成と `/complete` へのPOST

言語をTypeScriptにした理由は [ADR 0002](../docs/adr/0002-agent-runtime.md)。

## 起動

```bash
cp ../.env.example .env
pnpm --filter @ai-sensei/agent download-files   # Silero VADのモデルを取得
pnpm --filter @ai-sensei/agent dev              # ルームを待ち受ける
```

`workers/api` が `/v1/sessions` でルームを作ると、このワーカーがジョブを受け取る。

## 会話文脈はトークン経由で来る

`workers/api` が LiveKitトークンの `metadata` に、写真の解釈・許可トピック・
質問の種・残り秒数をJSONで載せている。別チャネルで渡すと、
トークンと文脈がずれたセッションが生まれうるため。

**metadataが読めなければ会話を始めずに切断する。** 文脈なしで後輩を喋らせると、
写真と関係ない一般論を聞き始めてしまうので、それくらいなら黙って終える。

## カルテ生成

`buildKarte()` は LiveKit に依存しないので単体でテストできる。

1. transcript全体 + 写真の要約 + 許可トピックで `karte_generation` プロンプトを組む
2. LLMの出力を `karteDraftSchema`(zod)で検証
3. 穴のtopic_idを許可リストで照合(サーバ側でも同じ照合をするが、送る前に落とす)
4. `/v1/sessions/{id}/complete` へ内部トークン付きでPOST

**ユーザーが一度も喋っていない会話では、カルテを作らない**(空のカルテを送る)。
LLMに無理やり穴を作らせない。空のカルテは失敗ではない。

## 答えの漏れについて(既知の限界)

`containsAnswerLeak()` は後輩の発話も見ているが、**realtimeなので発話を差し止められない**。
検出できるのは事後だけで、いまは `console.warn` に記録してプロンプト調整の材料にする。

W2のGo/No-Goで、漏れの頻度が問題になるようなら:

- 文単位でTTS前にフィルタする(遅延と引き換え)
- 会話モデルをより指示追従の強いものに上げる

のどちらかを検討する。
