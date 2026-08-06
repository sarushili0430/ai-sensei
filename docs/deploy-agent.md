# backend/agent のデプロイ

後輩AIの会話パイプライン(LiveKit Agents)を、手元の `pnpm dev` から**常駐するコンテナ**へ
移すための手順。`backend/api`(Cloudflare Workers)は [`docs/deploy.md`](deploy.md)、
言語選定の経緯は [ADR 0002](adr/0002-agent-runtime.md)。

| | develop | production |
| --- | --- | --- |
| ブランチ | `develop` | `main` |
| LiveKitプロジェクト | 開発用 | 本番用 |
| agent名 | `ai-sensei-agent-develop` | `ai-sensei-agent-production` |
| イメージのタグ | `:develop` | `:production` |
| `API_BASE_URL` | develop のワーカーURL | production のワーカーURL |
| `INTERNAL_API_TOKEN` | develop のsecretと同じ値 | production のsecretと同じ値 |

**LiveKitのプロジェクトは環境ごとに分ける。** 同じプロジェクトを共有すると、develop の
agentが本番のルームのジョブを拾いうる(そのとき会話は成立してしまうので、気づくのは
「本番のカルテがdevelopのD1に入っている」のを見つけたときになる)。

---

## 0. 何を動かすのか

`backend/agent` はビルド手順を持たず、`node --experimental-strip-types` で `.ts` を
直接実行する([ADR 0002](adr/0002-agent-runtime.md))。デプロイの実体は
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

Dockerfileは [`backend/agent/Dockerfile`](../backend/agent/Dockerfile)。
**ビルドコンテキストはリポジトリのルート**にする。agentは `packages/*` を
`workspace:*` で参照しているので、`backend/agent` だけを送ってもインストールが解けない。

```bash
docker build -f backend/agent/Dockerfile -t ai-sensei-agent:local .
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

### 2-1. モノレポなので「自分で焼いたイメージ」を渡す

`lk agent create` / `lk agent deploy` にはソースを送って向こうでビルドさせる方式が
あるが、**`package.json`・`Dockerfile`・ビルドコンテキストが同じディレクトリにある前提**で、
`workspace:*` を跨ぐ構成は解決できない
([livekit-cli#688](https://github.com/livekit/livekit-cli/issues/688))。

なので **bring your own container** を使う。イメージはこちらで焼き、
`--image`(レジストリ参照)または `--image-tar`(OCI tar)で渡す。
`backend/agent` を切り出して別リポジトリにする案は取らない
(`packages/guardrail` の二重実装を避けることがTypeScriptを選んだ理由そのものなので、
デプロイの都合でそこを崩すと本末転倒になる)。

### 2-2. 初回

```bash
# CLIを入れて、LiveKitのアカウントに繋ぐ
curl -sSL https://get.livekit.io/cli | bash
lk cloud auth

# イメージを焼いてレジストリへ上げる(GitHub Container Registry の例)
docker build -f backend/agent/Dockerfile -t ghcr.io/sarushili0430/ai-sensei-agent:develop .
docker push ghcr.io/sarushili0430/ai-sensei-agent:develop

# エージェントを登録する。secretは .env の形式のファイルから渡す
lk agent create \
  --image ghcr.io/sarushili0430/ai-sensei-agent:develop \
  --secrets-file backend/agent/.env.develop
```

成功すると **`livekit.toml` が書き出され、そこにagentのIDが入る**。
IDは環境ごとに違うので、このファイルは**コミットしない**(`.gitignore` 済み)。
develop用のIDが乗ったまま `main` で deploy すると、本番のつもりでdevelopを上書きする。

> `lk` はまだ動きの変わりやすいCLIなので、**初回だけ `lk agent create --help` で
> フラグ名を確かめてから**流すこと。ここに書いてあるのは 2026-08 時点の形。

### 2-3. 2回目以降

```bash
docker build -f backend/agent/Dockerfile -t ghcr.io/sarushili0430/ai-sensei-agent:develop .
docker push ghcr.io/sarushili0430/ai-sensei-agent:develop
lk agent deploy --image ghcr.io/sarushili0430/ai-sensei-agent:develop --id <agent-id>
```

```bash
lk agent status --id <agent-id>    # レプリカ数・CPU・状態
lk agent logs   --id <agent-id>    # 1行1JSONのログがそのまま出る
```

### 2-4. production

`--id` と `--secrets-file` とイメージのタグを production のものに差し替えて、同じことを2回やる。
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
| `DEEPGRAM_API_KEY` | 必須 | STTとTTSで共通 |
| `LLM_MODEL_CONVERSATION` / `LLM_MODEL_KARTE` | 任意 | 未設定なら `config.ts` の既定値 |
| `DEEPGRAM_TTS_MODEL_JA` / `_EN` | 任意 | **ふつうは触らない**(声はキャラクターそのもの) |
| `SENTRY_DSN` | 任意 | 未設定ならSentryへは何も送らない |
| `ENVIRONMENT` | 任意 | Sentryに出る名前。`develop` / `production` |
| `LIVEKIT_AGENT_NAME` | 環境次第 | [§4](#4-ディスパッチ) |

**足りない値があると起動時に落ちる**(`loadConfig` が起動時に1度だけ検証する)。
会話の途中で気づくのがいちばん高くつくので、そう作ってある。

- **`INTERNAL_API_TOKEN` は環境ごとに必ず別の値にする。** developのagentが本番の
  `/complete` を叩けてしまう([ADR 0003](adr/0003-internal-api-auth.md))。
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

イメージの置き場は GitHub Container Registry(`ghcr.io`)。`GITHUB_TOKEN` に
`packages: write` を付けるだけで push できるので、追加のsecretは要らない。

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
| 起動直後に落ちる | 環境変数の不足(`agentの環境変数が足りません: ...` が出る)。[§3](#3-secret) |
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
  最初に確かめるのは、[ADR 0002](adr/0002-agent-runtime.md) が挙げていたとおり
  **`prewarm`(Silero VADのロード)がコンテナで通ること**。`GET :8081/` が200に
  なれば通っている。
- **オートスケールの調整。** いまは1レプリカ想定。同時セッション数が読めるのは
  W2のGo/No-Go以降なので、それまでは台数を手で決める。
- **ロールバック。** イメージのタグを戻して deploy し直す以外の道を用意していない。
  タグを `:develop` のような可変タグにしているので、**戻すときはコミットハッシュの
  タグが要る**(`docs/ci/deploy-agent.yml` は両方を push している)。
