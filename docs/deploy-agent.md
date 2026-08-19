# backend/agent のデプロイ

後輩AIの会話パイプライン(LiveKit Agents)を、手元の `pnpm dev` から**常駐するコンテナ**へ
移すための手順。`backend/api`(Cloudflare Workers)は [`docs/deploy.md`](deploy.md)、
言語選定の経緯は [ADR 0002](adr.md#adr-0002)。

| | develop | production |
| --- | --- | --- |
| ブランチ | `develop` | `main` |
| LiveKitプロジェクト | 開発用 | 本番用 |
| agent名 | `ai-sensei-agent-develop` | `ai-sensei-agent-production` |
| `API_BASE_URL` | develop のワーカーURL | production のワーカーURL |
| `INTERNAL_API_TOKEN` | develop のsecretと同じ値 | production のsecretと同じ値 |

**LiveKitのプロジェクトは環境ごとに分ける。** 同じプロジェクトを共有すると、develop の
agentが本番のルームのジョブを拾いうる(そのとき会話は成立してしまうので、気づくのは
「本番のカルテがdevelopのD1に入っている」のを見つけたときになる)。

---

## 0. 何を動かすのか

`backend/agent` はビルド手順を持たず、`node --experimental-strip-types` で `.ts` を
直接実行する([ADR 0002](adr.md#adr-0002))。デプロイの実体は
**「Node 22のコンテナを1つ以上、常時起動しておく」**だけ。

ワーカーはLiveKitへWebSocketで登録し、ジョブが割り当てられるのを待つ。
HTTPを受けるサーバではないので、ロードバランサもURLも要らない。
代わりに **`0.0.0.0:8081` にヘルスチェック**が立つ。

| パス | 返るもの |
| --- | --- |
| `GET /` | LiveKitに登録できていれば `200`、まだなら `503` |
| `GET /worker` | `{"agent_name":"...","active_jobs":0,"sdk_version":"1.6.1",...}` |

**`503` は「プロセスが落ちている」ではなく「LiveKitに繋がっていない」。**
後輩が来ない調査では、まずここが `200` かを見る。

---

## 1. イメージを焼く

Dockerfileは**リポジトリのルート**([`Dockerfile`](../Dockerfile))。中身は
`backend/agent` なのにルートにあるのは、動かせない理由が2つあるため:

1. agentは `packages/*` を `workspace:*` で参照しているので、**ビルドコンテキストが
   リポジトリのルートでないとインストールが解けない**。
2. `lk agent create/deploy` は**作業ディレクトリをそのままビルドコンテキストにし、
   その直下の `Dockerfile` を読む**。パスを指定するフラグが無い([§2](#2-livekit-cloud-のエージェントホスティングに載せる))。

```bash
docker build -t ai-sensei-agent:local .
# 同じことをするショートカット
pnpm --filter @ai-sensei/agent run docker:build
```

手元で動かす(`.env` はローカル用のまま。`backend/api` は `pnpm --filter @ai-sensei/api dev` で別途起動しておく):

```bash
pnpm --filter @ai-sensei/agent run docker:run
curl -i http://localhost:8081/          # 200 になれば LiveKit に登録できている
curl -s http://localhost:8081/worker
```

> `API_BASE_URL=http://localhost:8787` のままコンテナで動かすと、コンテナの中の
> localhostを見にいってカルテのPOSTだけ失敗する。手元で通しで試すなら
> `--env API_BASE_URL=http://host.docker.internal:8787` を足す。

**`.env` の値をクォートで囲まないこと。** `pnpm dev` が使うNodeの `--env-file` は
`KEY="値"` の引用符を外すが、**`docker run --env-file` は外さない**(引用符も値の一部として
渡す)。同じ `.env` で **`pnpm dev` は通るのに `docker:run` だけ 401 になる**という、
いちばん時間を取られる形で出る。行末の空白も同じ。疑ったら中身を見る:

```bash
docker run --rm --env-file backend/agent/.env --entrypoint sh ai-sensei-agent:local -c \
  'printf "URL=[%s]\nKEY=[%s]\nSECRET_LEN=%s\n" "$LIVEKIT_URL" "$LIVEKIT_API_KEY" "${#LIVEKIT_API_SECRET}"'
```

`[]` の中に引用符や空白が見えたら `.env` 側を直す(秘密そのものは出さず、長さだけ見る)。

起動時に出る `onnxruntime cpuid_info warning: Unknown CPU vendor` は**無視してよい**。
CPUの銘柄を読めなかっただけで、推論はCPUで通っている(Apple Silicon上でamd64の
イメージをエミュレーションしているときによく出る)。

Dockerfileで効かせてあることのうち、外から見て分かりにくいものは3つ:

- **`ca-certificates` を入れている。** LiveKitのネイティブコア(Rust)はシステムの
  CA束を実行時に読む。slimイメージには入っていないので、入れないとLiveKitへの
  TLS接続だけがその場で失敗する。**コンテナにして初めて出る壊れ方**なので先に潰してある。
- **`ONNXRUNTIME_NODE_INSTALL=skip`。** onnxruntime-node の postinstall は既定で
  CUDA/TensorRTの実行プロバイダを **302MB** 取りに行くが、Silero VADはCPUで回すので
  使わない。CPU実行に要るぶんはnpmパッケージに同梱されている。
- **`pnpm` を挟まず `node` をPID 1にしている。** SIGTERMが来るとワーカーはdrain
  (進行中の会話を終わらせてから終了)する。間にプロセスを挟むとシグナルが素通りせず、
  **話している最中に切れる**。

---

## 2. LiveKit Cloud のエージェントホスティングに載せる

第一候補。LiveKitのグローバル網の上で動き、スケールとログ転送が付いてくる。

### 2-1. ソースを送って、向こうでビルドさせる

**`lk` はリポジトリのルートから叩く。** CLIは作業ディレクトリをそのまま
ビルドコンテキストにし、その直下の `Dockerfile` を読む。`Dockerfile` をルートに
置いてあるのはこのため([§1](#1-イメージを焼く))。

> ⚠️ **焼いたイメージを渡す道(`--image` / `--image-tar`)は使えない。**
> あれは**手元のDockerデーモンのイメージをLiveKitのレジストリへpushする**フラグで、
> その push 先が Enterprise プラン限定になっている。使うと
> `Bring Your Own Container is only available for Enterprise projects` で断られる。
>
> ```
> failed to get push target: push-target returned 403:
> {"errors":[{"code":"PERMISSION_DENIED","message":"Bring Your Own Container is
> only available for Enterprise projects. ..."}]}
> ```

`backend/agent` を切り出して別リポジトリにする案は取らない
(`packages/guardrail` の二重実装を避けることがTypeScriptを選んだ理由そのものなので、
デプロイの都合でそこを崩すと本末転倒になる)。

### 2-2. 初回

```bash
# CLIを入れて、LiveKitのアカウントに繋ぐ
curl -sSL https://get.livekit.io/cli | bash
lk cloud auth

# リポジトリのルートから。secretは .env の形式のファイルから渡す
cd <リポジトリのルート>
lk agent create --secrets-file <secretsファイル> --skip-sdk-check
```

`--skip-sdk-check` が要るのは、CLIが**作業ディレクトリの `package.json` に
`@livekit/agents` が入っているか**を見るため。ルートはワークスペースの器で、
依存を持っているのは `backend/agent/package.json` のほうなので、素通しすると
「SDKが無い」と言われる。**警告に落として先へ進めるだけ**で、ビルドには影響しない。

成功すると **`livekit.toml` が書き出され、そこにagentのIDが入る**。
IDは環境ごとに違うので、このファイルは**コミットしない**(`.gitignore` 済み)。
develop用のIDが乗ったまま `main` で deploy すると、本番のつもりでdevelopを上書きする。

> `lk` はまだ動きの変わりやすいCLIなので、**初回だけ `lk agent create --help` で
> フラグ名を確かめてから**流すこと。ここに書いてあるのは 2026-08 時点の形。

### 2-3. 2回目以降

**LiveKit metadata の契約を変えるリリースは、必ず agent を先にデプロイし、稼働を
確認してから `backend/api` をデプロイする。** APIとagentは別々に更新されるため、
同じコミットでも2つのデプロイの間には新旧が混在する窓がある。たとえば
`review_hole` を追加したAPIを先に出すと、古いagentの `sessionMetadataSchema` は
`.strict()` なので未知のキーを拒否し、`context_unreadable` で切断する。新規授業にも
`review_hole: null` が載るため、この窓では復習だけでなく**全セッションで先輩が来ない**。

agentを先に出した場合、新しいagentは古いAPIが `review_hole` を省略したmetadataも読める。
その窓の復習だけは `review_hole_missing` を記録して従来の板書なし会話へ縮退し、APIの
デプロイ後は自然に板書つきへ戻る。`lk agent status` で新しいレプリカの稼働を確認してから、
API側のデプロイを開始すること。2つのGitHub Actionsには依存関係がなく、同じpushで
起動しても順序は保証されない。契約変更時はこの節のCLIで対象コミットのagentを先に出すか、
リリースを2段に分け、稼働確認前にAPIのデプロイを開始してはいけない。

```bash
cd <リポジトリのルート>
lk agent deploy --id <agent-id>
```

ビルドは向こうで走る。**手元で `docker build` が通ることを先に確かめておく**と、
向こうのビルドログを読む回数が減る([§1](#1-イメージを焼く))。

```bash
lk agent status --id <agent-id>    # レプリカ数・CPU・状態
lk agent logs   --id <agent-id>    # 1行1JSONのログがそのまま出る
```

### 2-4. production

`--id` と `--secrets-file` を production のものに差し替えて、同じことを2回やる。
**`livekit.toml` を使い回さない**のがいちばんの事故防止になる。

---

## 3. secret

agentが読む環境変数は [`backend/agent/.env.example`](../backend/agent/.env.example) が正。
デプロイ先には**同じキーをそのまま**入れる。

| 名前 | 要否 | 中身 |
| --- | --- | --- |
| `API_BASE_URL` | 必須 | 環境に対応する `backend/api` のワーカーURL |
| `INTERNAL_API_TOKEN` | 必須 | **同じ環境の** `backend/api` のsecretと同じ値 |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 必須 | 環境に対応するLiveKitプロジェクトのもの |
| `ANTHROPIC_API_KEY` | 必須 | 会話とカルテのLLM |
| `DEEPGRAM_API_KEY` | 必須 | STT(聞く側) |
| `GOOGLE_API_KEY` | 必須 | TTS(喋る側)。Gemini API の鍵([ADR 0008](adr.md#adr-0008)) |
| `LLM_MODEL_CONVERSATION` / `LLM_MODEL_KARTE` | 任意 | 未設定なら `config.ts` の既定値 |
| `GEMINI_TTS_MODEL` | 任意 | 未設定なら `gemini-2.5-flash-preview-tts`。3.1 を試すときだけ入れる |
| `GEMINI_TTS_VOICE` | 任意 | **ふつうは触らない**(声はキャラクターそのもの) |
| `SENTRY_DSN` | 任意 | 未設定ならSentryへは何も送らない |
| `ENVIRONMENT` | 任意 | Sentryに出る名前。`develop` / `production` |
| `LIVEKIT_AGENT_NAME` | 環境次第 | [§4](#4-ディスパッチ) |

**足りない値があると起動時に落ちる**(`loadConfig` が起動時に1度だけ検証する)。
会話の途中で気づくのがいちばん高くつくので、そう作ってある。

- **`INTERNAL_API_TOKEN` は環境ごとに必ず別の値にする。** developのagentが本番の
  `/complete` を叩けてしまう([ADR 0003](adr.md#adr-0003))。
- **LiveKit Cloud のホスティングは `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
  `LIVEKIT_API_SECRET` を自分で注入する。** 自前で入れると食い違うことがあるので、
  そちらに載せるときは `--secrets-file` から3つを外してよい。

secretを入れ替えたら、**コードが変わっていなくてもデプロイし直す**(既に動いている
ワーカーのプロセスには新しい値が入らない)。

---

## 4. ディスパッチ

ワーカーの登録の仕方で、呼ばれ方が変わる。ここが `backend/api` 側の設定と噛み合っていないと、
**部屋は作られるのに後輩が来ない**(アプリは「聞いています」のまま止まる)。

| agent側 | 呼ばれ方 | `backend/api` の `LIVEKIT_AGENT_NAME` |
| --- | --- | --- |
| `LIVEKIT_AGENT_NAME` なし | 自動ディスパッチ。プロジェクトの全ルームに入る | 空のまま |
| `LIVEKIT_AGENT_NAME` あり | 明示ディスパッチのみ | **同じ名前を入れる** |

**LiveKit Cloud のエージェントホスティングは `LIVEKIT_AGENT_NAME` を自動で入れる。**
つまり載せ替えた瞬間に「名前つき」に変わるので、`backend/api` 側にも同じ名前を
入れないと後輩が来なくなる。

```bash
lk agent status --id <agent-id>                     # 名乗っている名前を確認する
curl -s http://localhost:8081/worker                # 手元なら agent_name を見る
cd backend/api && pnpm exec wrangler secret put LIVEKIT_AGENT_NAME --env develop
```

---

## 5. GitHub Actions から自動デプロイする

テンプレートは [`docs/ci/deploy-agent.yml`](ci/deploy-agent.yml)。
GitHub Appは `.github/workflows/` へpushできないため、**リポジトリオーナーが手元で
1度だけコピーする**(`backend/api` 側と同じ事情。[`docs/ci/README.md`](ci/README.md))。

```bash
cp docs/ci/deploy-agent.yml .github/workflows/deploy-agent.yml
git add .github/workflows/deploy-agent.yml
git commit -m "ci: enable agent deploy workflow"
```

必要な Secrets / Variables(Settings > Secrets and variables > Actions)。
develop と production を分けるなら、リポジトリ共通ではなく **Environments** 側に置く。

| 種別 | 名前 | 中身 |
| --- | --- | --- |
| Secret | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `lk` の認証に使う。環境に対応するLiveKitプロジェクトのもの |
| Secret | `LIVEKIT_URL` | 同上 |
| Variable | `LIVEKIT_AGENT_ID` | `lk agent create` が返したID(`CA_...`) |

**イメージのレジストリは要らない。** ワークフローがやるのはソースを送ることだけで、
ビルドはLiveKit側で走る。

---

## 6. LiveKit Cloud を使わない場合

コンテナが常駐できればどこでもよい(Fly.io / Render / ECS / Cloud Run の常時起動 /
自前のNode 22)。ADR 0002 でいう「不可の場合」の道で、**イメージはまったく同じ**。

押さえるのは4つだけ:

| 項目 | 値 | なぜ |
| --- | --- | --- |
| ヘルスチェック | `GET :8081/` が200 | LiveKitに登録できて初めて200になる |
| 停止時の猶予 | **60秒以上** | SIGTERMからdrain。短いと会話中に切れる |
| スケールの向き | 台数を増やす(1台を大きくしない) | ワーカーは負荷70%で新規ジョブを断る |
| メモリ | 1レプリカあたり 2GB を目安 | productionモードは `min(CPU数, 4)` 個の子プロセスを常駐させ、それぞれがVADモデルを持つ |

**スケールインしてゼロ台になる設定にはしない**(Cloud Run のように0台まで縮む構成だと、
ジョブが来た時点で誰も待ち受けていない)。

---

## 7. 動かなくなったときに見るもの

agentは**静かに壊れる**。アプリからは「後輩が来ない」「カルテが出ない」としか見えない。
ログは1行1JSONで、全行に `session_id` が入るので `backend/api` 側と突き合わせられる。

| 症状 | 見るもの |
| --- | --- |
| 後輩が来ない | まず `GET :8081/` が200か。200なら `job_started` の有無 → 無ければ[§4のディスパッチ](#4-ディスパッチ) |
| 起動直後に落ちる | `agentの環境変数を読めません: <名前>(<理由>)` が出る。名前と理由がそのまま原因。[§3](#3-secret) |
| `closing worker due to error.` としか出ない | フレームワークが起動中の例外を握り潰している。**環境変数はその手前で見ているので、ここまで来たら環境変数以外**(ポートの衝突など)を疑う |
| LiveKitに繋がらない(`401`) | 鍵が拒否されている。**`LIVEKIT_URL` のプロジェクトと `LIVEKIT_API_KEY`/`SECRET` の出どころが揃っているか**(環境を分けた直後の取り違えが定番)。次に `.env` のクォート・行末の空白([§1](#1-イメージを焼く)) |
| LiveKitに繋がらない(TLSで落ちる) | `ca-certificates` の有無(自前のイメージに差し替えたとき) |
| 会話は始まるがすぐ切れる | `context_unreadable`。APIが載せたトークンのmetadataを疑う |
| カルテが出ない | `karte_failed` / `complete_failed`、API側の `complete_unauthorized`。`INTERNAL_API_TOKEN` の環境違いが定番 |
| デプロイ直後だけ会話が切れる | 停止時の猶予が短くてdrainしきれていない([§6](#6-livekit-cloud-を使わない場合)) |

イベントの一覧は [`backend/agent/README.md`](../backend/agent/README.md#ログと監視)。
`SENTRY_DSN` を入れてあれば `*_failed` はSentryにも届く(会話の中身と写真の要約は送らない)。

---

## まだやっていないこと

- **実際のデプロイ。** ここに書いてあるのは手順で、まだ一度も流していない。
  最初に確かめるのは、[ADR 0002](adr.md#adr-0002) が挙げていたとおり
  **`prewarm`(Silero VADのロード)がコンテナで通ること**。`GET :8081/` が200に
  なれば通っている。
- **オートスケールの調整。** いまは1レプリカ想定。同時セッション数が読めるのは
  W2のGo/No-Go以降なので、それまでは台数を手で決める。
- **ロールバック。** LiveKit側でビルドするので、こちらにはイメージが残らない。
  いまは**戻したいコミットを checkout して deploy し直す**しかない
  (`lk agent rollback` があるかは未確認。`lk agent --help` で見ること)。
