# @ai-sensei/agent

先輩AIのセッション(授業 → 教え返し)。LiveKit Agents(Node)に乗せる。

```
フェーズ1「授業」   板書LLM(Claude) → 手順単位で LiveKit Text Streams → 直後にTTS
フェーズ2「教え返し」 VAD(Silero) → STT(Deepgram nova-3) → Claude(先輩ペルソナ)
                     → TTS(Gemini TTS)。割り込みと相づちはフレームワーク側。
```

**WebRTCは書かない。** ここで書くのは3つだけ:

1. 写真文脈の受け渡し(LiveKitトークンのmetadata → プロンプト)
2. 上限時間での打ち切り(サーバが決めた `max_seconds`)
3. セッション終了時のカルテ生成と `/complete` へのPOST

言語をTypeScriptにした理由は [ADR 0002](../docs/adr.md#adr-0002)。

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
そこへ載せたのにAPI側が空のままだと、部屋は作られるのに先輩が来ず、
アプリは「聞いています」のまま止まる(会話もカルテも起きない)。
`job_started` ログが出ていなければ、まずここを疑う。

## 会話文脈はトークン経由で来る

`backend/api` が LiveKitトークンの `metadata` に、写真の解釈・許可トピック・
質問の種・残り秒数をJSONで載せている。別チャネルで渡すと、
トークンと文脈がずれたセッションが生まれうるため。

明示ディスパッチのときは同じJSONがジョブのmetadataにも載る。
**先に読めたほうを使う**ので、ディスパッチの仕方を変えても会話は始まる。

**metadataが読めなければ会話を始めずに切断する。** 文脈なしで先輩を喋らせると、
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
| `completed` | 締めの言葉を言った(`closing.ts` が検出。読み上げの余白だけ待って閉じる) |
| `timeout` | サーバが決めた `max_seconds` に達した |
| `user_left` / `error` | 離脱・エラー |

**会話が終わったら、カルテ生成を待たずに先に部屋を閉じる。** 開けたままだと、
生成中(数秒)も話し続けられて上限時間を超えてしまう。`duration_seconds` も
部屋を閉じた時刻で測る(生成のレイテンシを混ぜると5分のセッションが6分になる)。

## ロケール

`locale` はAPIが受け付ける値なので、STT・読み方の指示・最初の挨拶をそれに合わせる。
日本語のSTTモデルのまま英語を流すと認識が崩れて会話にならない。
**声だけはロケールで変えない**([ADR 0008](../../docs/adr.md#adr-0008))。

**プロンプトも言語ごとに別本**を使う(`prompts/<id>.<locale>.md`)。
日本語の本文に「英語で答える」を足す作りはやめた
([ADR 0005](../../docs/adr.md#adr-0005))。ペルソナも禁止事項も
few-shot も、その言語で書かれたものをそのまま渡す。

言語で変わるのはこの5つ。ひとつでも取り違えると、英語で話しながら日本語の
基準でガードレールを引くことになる。

| | 切り替えるもの |
| --- | --- |
| STT | `deepgram.STT` の `language` |
| TTS | 読み方の指示と文分割器だけ。**声は日英で同じ1つ**([ADR 0008](../../docs/adr.md#adr-0008)) |
| プロンプト | `conversationSystemPrompt(vars, locale)` / `boardLessonSystemPrompt(vars, locale)` / `karteSystemPrompt(vars, locale)` |
| transcriptの整形 | ロール名(`先輩:` / `Senpai:`) |
| 定型の一言 | `senpai.ts`(教え返しへの受け渡し・復習の入り)。冒頭の無音埋めだけはモバイルの同梱アセット |
| ガードレール | 答えの漏れの検出と数式音声の正規化(`normalizeMathSpeech(text, locale)`) |

許可トピックは `locale` を見ずに済む。topic_id の接頭辞がロケールごとに
分かれているので、APIが渡した許可リストがそのまま課程を決める。

## 声(TTS)

聞く側と喋る側でベンダーが分かれている([ADR 0008](../../docs/adr.md#adr-0008))。
組み立ては `voice-session.ts` の `createSenpaiTts()` 1箇所。

| | |
| --- | --- |
| モデル | 既定 `gemini-2.5-flash-preview-tts`。`GEMINI_TTS_MODEL` で `gemini-3.1-flash-tts-preview` へ |
| 声 | `Leda` 固定。**日英で同じ1つ**(Geminiのボイスは言語を選ばない) |
| 正 | `senpai-voice.ts`。冒頭の同梱音声を焼くスクリプトも同じ定数を読む |

**Gemini TTS はストリーミングを持たない。**`tts.StreamAdapter` で包んで文分割器を
渡している。包み忘れるとSDKが既定の分割器を当て、日本語が「。」で切れなくなって
生成が終わるまで1文も喋らない。**分割された1文がそのまま1リクエスト**なので、
最初の音までの待ちは `sentence-tokenizer.ja.ts` の切り方でほぼ決まる。

正確には「**入力テキストの**ストリーミングを持たない」で、
`capabilities.streaming === false` はそちらを指す。音声の**出力**はプラグインが
`generateContentStream` で受けて届いたぶんから流している。Deepgramは
セッション中ずっと開いたWSへ文字を流し込めたが、Geminiは1文ごとに新しいHTTP。
最初の音までの重さはここから来る。

文と文の間は詰まっている。`StreamAdapter` は `await prevTask` の**前**に
次の文の `synthesize()` を呼び、`ChunkedStream` はコンストラクタで走り出すので、
2文目以降は1文目の再生中に飛んでいる。効くのは**1文目のTTFBだけ**。

その1文目を、`turnHandling.preemptiveGeneration.preemptiveTts` で
**ターンが確定する前**から走らせている(SDK既定は `false` で、TTSは
`_waitForScheduled()` を抜けてから動き出す)。endpointing の待ち
(minDelay 300ms / maxDelay 4,000ms)の裏でGeminiが回るぶん、沈黙が短くなる。
代償は**外したターンの合成を捨てる**こと。効きとハズレ率は下の `voice_metrics` で見る。

数式の読み替え(`toSpeakableJa`)は**残してある**。Geminiは記号を読めるが、
「1/2 → にぶんのいち」のような日本語の数学の読み順まではモデルの気分に任せない。

**モデル名はプラグインの型を信用しないこと。**`GeminiTTSModels` には
`gemini-2.5-flash-tts` のような**存在しない名前**が混じっている。`model` は
`string` として素通しされるので、間違えても起動は通り、最初に喋る瞬間に落ちる。
実在するIDは `senpai-voice.ts` の `geminiTtsModels` にまとめてある。

## ログと監視

**ここはいちばん静かに壊れる場所。** ワーカーが動いていない・ディスパッチが
来ない・カルテのLLMが落ちた、のどれが起きてもアプリからは
「先輩が来ない / 板書が出ない / カルテが出ない」としか見えない。ジョブの節目を1行1JSONで出す。

| event | いつ | 見かた |
| --- | --- | --- |
| `job_started` | ジョブを受け取った | これが無ければディスパッチが届いていない |
| `context_unreadable` | 文脈が読めない。会話せずに切る | APIのmetadataを疑う |
| `conversation_started` | セッションが立ち上がった(授業の**前**) | ここまで来れば先輩は喋れる状態 |
| `review_hole_missing` | 古いAPIが作った復習。板書なし会話へ縮退 | APIのデプロイ後も続くなら版ずれを疑う |
| `lesson_finished` / `lesson_empty` | 授業1回ぶんの結果 | `lesson_empty` は8/16ゲートを見る指標 |
| `board_figure_delivered` | 図を端末へ配送した | items/SVG本文は残さず、viewBox・最小距離/角・衝突・はみ出し・自動修正だけを見る |
| `voice_metrics` | STT/LLM/TTS/EOTの1リクエストごと | レイテンシ(`ttft_ms` / `ttfb_ms` / `eou_delay_ms`)と原価(`prompt_tokens` / `cached_tokens`) |
| `conversation_ended` | `completed` / `timeout` / `user_left` / `error` | 終わり方と発話数。`voice_metrics` のセッション集計もここに乗る |
| `karte_built` / `karte_failed` | カルテ生成 | 穴の数と所要時間 |
| `complete_posted` / `complete_failed` | APIへの送信 | **失敗するとカルテは表に出ない** |

`session_id` が全行に入るので、`backend/api` 側のログ(`session_created` /
`karte_stored`)と突き合わせられる。

`SENTRY_DSN` を設定すると、エラーはSentryにも飛ぶ(未設定なら何も送らない)。
会話の中身と写真の要約は送らない。

`/complete` は落ちても3回まで送り直す(冪等なので二重にはならない)。

### 原価は `conversation_ended` の1行で見る

レイテンシだけ見ていると原価が見えない。とくに**会話LLMの指示文**は
`senpai_conversation.<locale>.md`(日本語版11,000字)に板書の要約と写真の読み取りが
載って1万トークン級になり、**毎ターン丸ごと再送される**。プラグイン(1.6.1)は
`cache_control` を付けないので、`conversation-llm.ts` の `CachedInstructionsLLM` で
指示文にプロンプトキャッシュの印を足している。

| フィールド | 見かた |
| --- | --- |
| `llm_prompt_tokens` | 会話LLMへ送った入力の合計。原価の主役 |
| `llm_cached_tokens` | そのうちキャッシュから読めたぶん(単価は通常入力の 0.1 倍) |
| `llm_cache_hit_ratio` | **効いていれば 0.8 前後**。0 のまま動かないときは下を疑う |
| `tts_ttfb_ms_avg` | 最初の音までの待ち。`preemptiveTts` の効きはここに出る |
| `speech_ratio` | 生徒 ÷ 先輩。1未満なら教え返しが成立していない |

`llm_cache_hit_ratio` が 0 のままなら、原因は2つのどちらか。

- **指示文が毎ターン変わっている。** `agent.ts` の `updateInstructions` は
  問題の切り替えと授業の終わりでしか呼ばない前提。呼ぶ頻度を上げると
  キャッシュは死に、書き込みは通常の1.25倍なので**付けないより高くつく**
- **指示文が短くなった。** Haiku 4.5 のキャッシュ最小長は4,096トークンで、
  下回るとエラーも警告もなく黙って無視される

先読み(`preemptiveTts`)の効きは、SDKが出すログで見る。
`using preemptive generation` の `preemptiveLeadTime` が**隠せた時間**、
`preemptive generation enabled but chat context or tools have changed` が**ハズレ**。
ハズレたぶんの合成は捨てられるので、比が悪ければ `voice-session.ts` で外す。

## 答えの漏れの検知は、もう当てていない

`containsAnswerLeak()` は**改正前の約束1「答えを教えない」を守るための検知**で、
ピボットで配役が先輩に変わったあとは当てていない
(ピボット計画 v1 §0 の改正・§8 の「捨てる」列)。

当てたままにすると、**先輩が詰まった箇所を教えるたびに漏れとして記録される**。
教えるのが仕事なので、ほぼ全セッションで警告が鳴り、本物の異常を見落とす方向にしか働かない。

**改正後に残っている約束は「先に答えを埋めない」**(まず言わせてから教える)だが、
これは1発話の字面では判定できない — **同じ文が、生徒が説明したあとなら正しく、
説明する前なら違反になる**。ターンの順序を見る必要があるので、
正規表現のガードレールでは原理的に置き換えられない。

いま守っているのは `prompts/senpai_conversation.<locale>.md` の約束1だけで、
**コード側の相手はいない**(`prompts/README.md` の二重書きの表に「無し」と明記してある)。
ここを機械で見たくなったら、字面ではなく**ターンの順序**を見る設計から始めること。
