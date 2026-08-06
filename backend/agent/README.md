# @ai-sensei/agent

後輩AIの会話パイプライン。LiveKit Agents(Node)に乗せる。

```
VAD(Silero) → 日本語ストリーミングSTT(Deepgram) → Claude(後輩ペルソナ)
→ TTS(Deepgram Aura-2)。割り込みと相づちはフレームワーク側。
```

**WebRTCは書かない。** ここで書くのは3つだけ:

1. 写真文脈の受け渡し(LiveKitトークンのmetadata → プロンプト)
2. 上限時間での打ち切り(サーバが決めた `max_seconds`)
3. セッション終了時のカルテ生成と `/complete` へのPOST

言語をTypeScriptにした理由は [ADR 0002](../docs/adr/0002-agent-runtime.md)。

## 起動

```bash
cp .env.example .env
pnpm --filter @ai-sensei/agent download-files   # Silero VADのモデルを取得
pnpm --filter @ai-sensei/agent dev              # ルームを待ち受ける
```

`backend/api` が `/v1/sessions` でルームを作ると、このワーカーがジョブを受け取る。

## デプロイ

常駐するコンテナにする。**Dockerfileはリポジトリのルート**
([`../../Dockerfile`](../../Dockerfile))にある。ここに無いのは、
`packages/*` を `workspace:*` で参照しているからだけでなく、`lk agent deploy` が
作業ディレクトリ直下の `Dockerfile` しか読まないため(ADR 0002 の追記)。

```bash
pnpm --filter @ai-sensei/agent run docker:build   # リポジトリのルートで docker build . 相当
pnpm --filter @ai-sensei/agent run docker:run     # .env を渡して手元で起動
curl -i http://localhost:8081/                    # 200 なら LiveKit に登録できている
```

**`0.0.0.0:8081` にヘルスチェックが立つ**(`GET /` が200/503、`GET /worker` が稼働状況)。
`503` は「落ちている」ではなく「まだLiveKitに繋がっていない」。

稼働先(LiveKit Cloud のエージェントホスティング / 任意のコンテナホスト)、secretの
入れ方、GitHub Actionsからの自動デプロイは [`docs/deploy-agent.md`](../../docs/deploy-agent.md)。

## ディスパッチ(誰がこのワーカーを呼ぶか)

ワーカーの登録の仕方で、呼ばれ方が変わる。

| 登録 | 呼ばれ方 | API側 |
| --- | --- | --- |
| 名前なし(既定) | 自動ディスパッチ。プロジェクトの全ルームに入る | 設定なし |
| 名前つき(`LIVEKIT_AGENT_NAME`) | 明示ディスパッチのみ | `LIVEKIT_AGENT_NAME` に同じ名前 |

**LiveKit Cloud のエージェントホスティングは `LIVEKIT_AGENT_NAME` を自動で入れる。**
そこへ載せたのにAPI側が空のままだと、部屋は作られるのに後輩が来ず、
アプリは「聞いています」のまま止まる(会話もカルテも起きない)。
`job_started` ログが出ていなければ、まずここを疑う。

## 会話文脈はトークン経由で来る

`backend/api` が LiveKitトークンの `metadata` に、写真の解釈・許可トピック・
質問の種・残り秒数をJSONで載せている。別チャネルで渡すと、
トークンと文脈がずれたセッションが生まれうるため。

明示ディスパッチのときは同じJSONがジョブのmetadataにも載る。
**先に読めたほうを使う**ので、ディスパッチの仕方を変えても会話は始まる。

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

## 会話の終わり方

3通りある。どれで終わったかは `ended_reason` としてカルテ側の重み付けに使う。

| ended_reason | きっかけ |
| --- | --- |
| `completed` | 後輩が締めの言葉を言った(`closing.ts` が検出。読み上げの余白だけ待って閉じる) |
| `timeout` | サーバが決めた `max_seconds` に達した |
| `user_left` / `error` | 離脱・エラー |

**会話が終わったら、カルテ生成を待たずに先に部屋を閉じる。** 開けたままだと、
生成中(数秒)も話し続けられて上限時間を超えてしまう。`duration_seconds` も
部屋を閉じた時刻で測る(生成のレイテンシを混ぜると5分のセッションが6分になる)。

## ロケール

`locale` はAPIが受け付ける値なので、STTの言語と最初の挨拶をそれに合わせる。
日本語モデルのまま英語を流すと認識が崩れて会話にならない。

プロンプト本体は日本語のままで、`locale=en` のときは「英語で答える」指示だけを
足している。プロンプトの英訳はW4の磨き込みで行う。

## ログと監視

**ここはいちばん静かに壊れる場所。** ワーカーが動いていない・ディスパッチが
来ない・カルテのLLMが落ちた、のどれが起きてもアプリからは
「後輩が来ない / カルテが出ない」としか見えない。ジョブの節目を1行1JSONで出す。

| event | いつ | 見かた |
| --- | --- | --- |
| `job_started` | ジョブを受け取った | これが無ければディスパッチが届いていない |
| `context_unreadable` | 文脈が読めない。会話せずに切る | APIのmetadataを疑う |
| `conversation_started` | 最初の一言を出した | ここまで来れば後輩は喋っている |
| `conversation_ended` | `completed` / `timeout` / `user_left` / `error` | 終わり方と発話数 |
| `karte_built` / `karte_failed` | カルテ生成 | 穴の数と所要時間 |
| `complete_posted` / `complete_failed` | APIへの送信 | **失敗するとカルテは表に出ない** |

`session_id` が全行に入るので、`backend/api` 側のログ(`session_created` /
`karte_stored`)と突き合わせられる。

`SENTRY_DSN` を設定すると、エラーはSentryにも飛ぶ(未設定なら何も送らない)。
会話の中身と写真の要約は送らない。

`/complete` は落ちても3回まで送り直す(冪等なので二重にはならない)。

## 答えの漏れについて(既知の限界)

`containsAnswerLeak()` は後輩の発話も見ているが、**realtimeなので発話を差し止められない**。
検出できるのは事後だけで、いまは `console.warn` に記録してプロンプト調整の材料にする。

W2のGo/No-Goで、漏れの頻度が問題になるようなら:

- 文単位でTTS前にフィルタする(遅延と引き換え)
- 会話モデルをより指示追従の強いものに上げる

のどちらかを検討する。
