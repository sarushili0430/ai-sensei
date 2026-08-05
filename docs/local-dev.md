# ローカル開発

**backendはDocker、アプリは母艦のFlutter。** 迷ったらこの1行に戻ってください。

```
母艦(macOS)                              Docker                      外
─────────────────────────────────         ────────────────────        ─────────
Flutter (--debug)  ──HTTP:8787──▶  backend/api (wrangler dev)
  iOSシミュレータ / 実機                    │ D1・R2・KVはminiflareの偽物
                                          │
   └────────────WebRTC──────────────────────────────────────────▶ LiveKit Cloud
                                   backend/agent ────────────────▶ ↑ 同じ部屋に入る
                                     (--profile agent)             Anthropic / Deepgram
                                          │                        / ElevenLabs
                                          └──HTTP──▶ api:8787(カルテのPOST)
```

Flutterをコンテナに入れないのは、**iOSシミュレータもXcodeも母艦にしか無い**からです。
コンテナに入れられるのはbackendまでで、そこから先を無理に入れると
「ビルドは通るのに実機で確かめられない」状態になります。

---

## 1. 前提

| ツール | 用途 |
| --- | --- |
| Docker Desktop(or 互換のengine) | backend/api・backend/agent |
| Flutter 3.44.8(`.fvmrc`。fvm推奨) | apps/mobile |
| Xcode 16以上 | iOSシミュレータ・実機(macOSのみ) |

母艦のNodeは**必須ではありません**。ただしエディタの補完(TypeScript)を効かせるなら、
母艦にも `pnpm install` しておくのが楽です。コンテナ側の node_modules とは別物として
扱われるので、両方あって構いません(後述)。

## 2. 環境変数

```bash
cp backend/api/.dev.vars.example        backend/api/.dev.vars
cp backend/agent/.env.example           backend/agent/.env
cp apps/mobile/dart_defines.example.env apps/mobile/dart_defines.env
```

**鍵が無くてもbackendは起動します。** どこまで動くかは分かれます。

| 触れるもの | 鍵が要るか |
| --- | --- |
| `GET /health`、`GET /v1/me/*` | 要らない |
| `POST /v1/sessions` | 要る(写真解析=Anthropic、ルーム作成=LiveKit) |
| 会話(agent) | 要る(LiveKit / Anthropic / Deepgram / ElevenLabs) |
| 課金・プッシュ | 要らない(未設定なら該当機能を飛ばして動く) |

## 3. 起動と停止

```bash
docker compose up                    # backend/api → http://localhost:8787
docker compose --profile agent up    # + backend/agent
docker compose down                  # 停止
docker compose down --volumes        # ローカルD1のデータと node_modules ごと捨てる
```

`package.json` にも同じものを置いてあります(`pnpm run dev` / `dev:agent` /
`dev:down` / `dev:reset`)。

初回はイメージのビルドと依存の解決で数分かかります。2回目以降は数秒です。
起動したかどうかは `/health` で見ます。

```bash
curl http://localhost:8787/health
# {"ok":true,"environment":"local"}

curl http://localhost:8787/v1/me/progress -H 'x-device-id: 11111111-2222-3333-4444-555555555555'
# 匿名デバイスIDはUUID形式でないと401になる(lib/ids.ts)
```

D1のマイグレーションは**起動のたびに流れます**(適用済みは飛ばされる)。
マイグレーションを足した日に「なぜかテーブルが無い」で悩まないためです。

## 4. コンテナの中で何が起きているか

`docker-compose.yml` のサービスは3つです。

| サービス | 役割 |
| --- | --- |
| `deps` | `pnpm install --frozen-lockfile` を1回だけ走らせて終了する |
| `api` | マイグレーション → `wrangler dev --ip 0.0.0.0 --port 8787` |
| `agent` | `pnpm run dev`(LiveKitのルームを待ち受ける)。`--profile agent` のときだけ |

**なぜ `deps` が別サービスなのか。** api と agent の両方に install させると、
同じvolumeへ同時に書いて壊れます。入口を1本にして、2つのサービスは
「install が完了していること」を条件に起動します。

**なぜ node_modules をvolumeに隔離するのか。** 母艦(macOS)の node_modules には
darwin版のnative依存(onnxruntime・sharp・workerd)が入っていて、
Linuxのコンテナはそれを読めません。ソースだけbind mountして、
node_modules はコンテナ専用のvolumeに置いています。
**母艦の `pnpm install` とコンテナの install は互いに影響しません。**

**なぜ `.wrangler` もvolumeなのか。** ローカルのD1はSQLiteのファイルで、
bind mount(VirtioFS)越しに触るとロックが不安定になります。
そのかわり、母艦で `wrangler dev` を動かしたときのローカルDBとは**別物**になります。
中身を捨てたいときは `docker compose down --volumes`。

ソース(`backend/` `packages/` `prompts/`)はbind mountなので、
保存すればwranglerのリロードがそのまま効きます。

## 5. アプリを起動する

```bash
cd apps/mobile
fvm install                       # 初回だけ(.fvmrc のバージョンを取得)
fvm flutter pub get
fvm dart run build_runner build   # freezed / riverpod の生成物(コミットしていない)

fvm flutter run --debug --dart-define-from-file=dart_defines.env
```

`flutter run` は既定でdebugモードなので、`--debug` は明示のためのものです。
起動したら `r` ホットリロード / `R` ホットリスタート / `q` 終了。
デバイスを選ぶなら `fvm flutter devices` → `-d <id>`。

生成物を作り直しながら開発するなら、別のシェルで:

```bash
fvm dart run build_runner watch --delete-conflicting-outputs
```

### 接続先(`dart_defines.env` の `API_BASE_URL`)

| アプリの実行先 | `API_BASE_URL` | なぜ |
| --- | --- | --- |
| iOSシミュレータ | `http://localhost:8787` | 母艦のlocalhostがそのまま見える |
| Androidエミュレータ | `http://10.0.2.2:8787` | `10.0.2.2` がエミュレータから見た母艦 |
| 実機(iOS/Android) | `http://<母艦のLAN IP>:8787` | 母艦と同じWi-Fiに繋ぐ |

母艦のLAN IPは `ipconfig getifaddr en0`(macOS)で取れます。
コンテナのポートは `0.0.0.0:8787` に出しているので、実機からそのまま届きます。

Androidの平文HTTPは、debugビルドのマニフェストで許可済みです
(`android/app/src/debug/AndroidManifest.xml`。releaseには混ざりません)。

## 6. Dockerを使わずに母艦で動かす

APIだけをいじる日は、こちらのほうが速いです(コンテナのファイル監視を挟まない)。

```bash
pnpm install
pnpm --filter @ai-sensei/api migrate:local
pnpm --filter @ai-sensei/api dev       # http://localhost:8787
pnpm --filter @ai-sensei/agent dev     # 会話まで通すとき
```

母艦の `wrangler dev` は既定でlocalhostにしか出ないので、実機から叩くなら
`pnpm --filter @ai-sensei/api dev --ip 0.0.0.0` を付けてください。
`docker compose` と同時には上げられません(8787がぶつかる)。

## 7. うまくいかないとき

**`deps` が `--frozen-lockfile` で落ちる**
`pnpm-lock.yaml` が `package.json` とずれています。母艦で `pnpm install` を回して、
更新された lockfile をコミットしてください(コンテナには書き換えさせない方針です)。

**8787がすでに使われている**
母艦の `wrangler dev` が残っています。止めるか、`docker-compose.yml` の
`ports` を `"8788:8787"` のように変えて、`API_BASE_URL` も合わせてください。

**保存してもリロードされない**
bind mount越しのファイル監視が落ちることがあります。`docker compose restart api`
で戻ります。頻発するなら §6 の母艦起動に切り替えてください。

**Androidエミュレータから繋がらない**
`API_BASE_URL` が `localhost` のままだと、エミュレータ自身を指してしまいます。
`http://10.0.2.2:8787` にしてください。

**iOS実機で通信が弾かれる**
ATSが平文HTTPを止めています。開発中だけ `ios/Runner/Info.plist` に
`NSAppTransportSecurity` → `NSAllowsLocalNetworking` を足すか、
シミュレータ(`localhost`)で済ませてください。
**足したまま提出しないこと**(審査で理由を聞かれます)。

**agentが起動直後に落ちる**
`agentの環境変数が足りません: ...` と出ていれば、そのキーが `backend/agent/.env` に
入っていません(足りない値があると会話の途中ではなく起動時に落とす作りです)。

**native依存が見つからない(Apple Silicon)**
linux/arm64のprebuiltが無いパッケージがあると、`deps` か `agent` が落ちます。
`docker-compose.yml` の `x-node-dev` に `platform: linux/amd64` を足すと、
エミュレーションで通ります(遅くなります)。

**全部やり直したい**

```bash
docker compose down --volumes
docker compose build --no-cache
docker compose up
```

## 8. LiveKitはローカルに立てていない

`livekit-server --dev` をコンテナで動かす手もありますが、WebRTCのメディアは
UDPの広いポート範囲を使うので、Docker DesktopのNAT越しに実機やシミュレータから
繋ぐのが安定しません。**LiveKit Cloudの無料プロジェクトを開発用に1つ作る**ほうが、
ハマる時間を考えれば速いです。

本番とは**必ず別プロジェクト**にしてください。同じプロジェクトを共有すると、
手元のagentが本番のルームのジョブを拾いえます(README「デプロイ」の注記と同じ理由)。
