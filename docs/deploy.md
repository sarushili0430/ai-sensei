# backend/api のデプロイ

Cloudflare Workers に **develop / production の2本**を立てる手順。
設定の実体は [`backend/api/wrangler.toml`](../backend/api/wrangler.toml)、
自動デプロイは [`docs/ci/deploy.yml`](ci/deploy.yml)
(GitHub App は `.github/workflows/` へpushできないため、ここはテンプレート置き場。
[§4-0](#4-0-ワークフローを配置する) で1度だけ手元からコピーする)。

| | develop | production |
| --- | --- | --- |
| ブランチ | `develop` | `main` |
| ワーカー名 | `ai-sensei-api-develop` | `ai-sensei-api-production` |
| D1 | `ai-sensei-develop` | `ai-sensei-production` |
| R2 | `ai-sensei-photos-develop` | `ai-sensei-photos-production` |
| KV | 別ネームスペース | 別ネームスペース |
| secret | `--env develop` で登録 | `--env production` で登録 |

**バインディング名(`DB` / `PHOTOS` / `METER`)は両環境で同じ**にしてある。
コードは環境を意識せず、実体だけが分かれる。develop で流したテストデータや
消し損ねたカルテが本番に混ざらないように、D1もR2もKVも共有しない。

`backend/agent`(LiveKit Agents)のデプロイは [`docs/deploy-agent.md`](deploy-agent.md)。
ここでは扱わないが、**agentから見た接続先は環境ごとに変わる**ので
[§6](#6-まわりの設定) に書いてある。

---

## 0. 前提

```bash
pnpm install
pnpm --filter @ai-sensei/api exec wrangler login   # ブラウザでCloudflareにログイン
```

Cloudflareの無料プランで足りる範囲だが、**D1・R2・KVはアカウントで初回に
有効化が要る**ことがある。以下の `create` が権限エラーになったら、
ダッシュボードで各プロダクトを一度開いて有効化する。

> このリポジトリには実際のCloudflareアカウントの値は入っていない。
> 以下は**まだ実行されていない手順**で、リソースIDは自分で作って差し替える。

---

## 1. リソースを作る(環境ごとに1回)

`develop` と `production` で、同じことを2回やる。以下は develop の例。

### D1

```bash
cd backend/api
pnpm exec wrangler d1 create ai-sensei-develop
```

出力の `database_id` を `wrangler.toml` の
`[[env.develop.d1_databases]]` の `REPLACE_ME` に貼る。

### KV(無料枠のメータリング)

```bash
pnpm exec wrangler kv namespace create METER --env develop
```

出力の `id` を `[[env.develop.kv_namespaces]]` の `REPLACE_ME` に貼る。

### R2(ノート写真)

```bash
pnpm exec wrangler r2 bucket create ai-sensei-photos-develop
```

R2はバケット名で引くのでIDの差し替えは要らない。

### production 側

`develop` を `production` に読み替えて同じ3つを作り、
`[[env.production.*]]` の `REPLACE_ME` を埋める。

埋まっているかは、環境ごとに手元で確かめられる。

```bash
pnpm run verify:bindings develop
# ✔ [env.develop] のバインディングは設定済み
```

**`REPLACE_ME` が残っている環境へはデプロイできない**(GitHub Actions の
`Check bindings are filled in` が同じチェックで落とす)。見るのは
**対象環境のセクションだけ**なので、**develop を先に立ち上げて production は
あとから作る、という順番で問題ない。**

---

## 2. secret を入れる

`wrangler.toml` の `[vars]` に置くのは**公開してよい設定だけ**。
鍵は環境ごとに `wrangler secret put` で入れる。

```bash
cd backend/api
for name in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET \
            ANTHROPIC_API_KEY ONESIGNAL_APP_ID ONESIGNAL_REST_API_KEY \
            REVENUECAT_WEBHOOK_AUTH INTERNAL_API_TOKEN; do
  pnpm exec wrangler secret put "$name" --env develop
done
```

任意で2つ。

```bash
pnpm exec wrangler secret put SENTRY_DSN --env develop          # エラーをSentryへ
pnpm exec wrangler secret put LIVEKIT_AGENT_NAME --env develop  # agentが名前つきのとき
```

**`LIVEKIT_AGENT_NAME` は、agentワーカーを名前つきで動かしているときだけ**入れる
(LiveKit Cloud のエージェントホスティングは自動で名前が付く)。名前つきワーカーは
自動ディスパッチの対象外なので、ここが空だと部屋は作られるのに後輩が来ず、
アプリは「聞いています」のまま止まる。詳細は
[backend/api/README.md](../backend/api/README.md#会話の相手agentをどう呼ぶか)。

`pnpm run secret:develop <NAME>` / `secret:production <NAME>` でも同じ
(`--env` の付け忘れを防ぐためのショートカット)。
中身の説明は [`backend/api/.dev.vars.example`](../backend/api/.dev.vars.example)。

**値は引数では渡せない。** `wrangler secret put` の positional は `<key>` だけで、
値はプロンプト(stdin)から入れる。CLIに書くとシェル履歴に残るための設計なので、
基本は聞かれてから貼る。5個まとめて入れたいときは
`wrangler secret bulk <file>.json --env develop`(平文なのでリポジトリの外に置き、
使ったら消す)。

初回は **「There doesn't seem to be a Worker called "ai-sensei-api-develop".
Do you want to create a new Worker with that name...?」** と聞かれる。**yes でよい。**
secretの置き場所としてワーカーの箱が先に作られ、あとで `deploy:develop` が
そこへコードを載せる。secretはデプロイをまたいで残るので入れ直しは要らない。

いくつか注意:

- **`REVENUECAT_WEBHOOK_AUTH` を空のままにするとwebhookは全部拒否される。**
  空文字で認可しないための仕様なので、未設定=閉じている、で正しい。
- **`INTERNAL_API_TOKEN` は agent 側と同じ値**にする。**環境ごとに必ず別の値にすること**
  (develop の agent が本番の `/complete` を叩けてしまうため)。この値は静的で
  スコープが無く、持っていれば任意のセッションにカルテを書ける。
  セッションスコープの短命トークンへ移す予定と、その理由は
  [ADR 0003](adr.md#adr-0003)。
- `ONESIGNAL_*` は未設定でも動く(プッシュの予約をスキップする)。
  develop では入れない、という運用もできる。

登録済みの一覧は `pnpm exec wrangler secret list --env develop`。

---

## 3. マイグレーションと初回デプロイ

**LiveKit metadata の契約を変えるリリースでは、APIより先にagentをデプロイする。**
手順と理由は [`docs/deploy-agent.md` §2-3](deploy-agent.md#2-3-2回目以降)。APIを先に
出すと、新しいキーを含むmetadataを `.strict()` な古いagentが拒否し、
`context_unreadable` で全セッションを切断しうる。今回の `review_hole` も新規授業には
`null` で載るため、影響は復習だけに限られない。先に新しいagentの稼働を確認すれば、
古いAPIがキーを省略する窓は復習だけが警告つきの板書なし会話へ縮退し、接続は切れない。
agentとAPIのGitHub Actionsは独立しており、同じpushでも順序は保証されない。契約変更時は
対象コミットのagentをCLIで先行デプロイするかリリースを2段に分け、agentの稼働確認後に
APIを開始する。

```bash
cd backend/api
pnpm run migrate:develop     # D1にスキーマを流す
pnpm run deploy:develop
```

`wrangler deploy` が出す `https://ai-sensei-api-develop.<subdomain>.workers.dev` を控える。

```bash
curl https://ai-sensei-api-develop.<subdomain>.workers.dev/health
# {"ok":true,"environment":"develop"}
```

`environment` が返るのは、**develop と production を取り違えていないか**を
1回のcurlで確かめられるようにするため。production も同じ手順で。

> `--env` を付けない `wrangler deploy` は、トップレベルの名前(`ai-sensei-api`)で
> **3本目のワーカー**を作ってしまう。`pnpm run deploy` は付け忘れとみなして
> 落ちるようにしてあるので、`deploy:develop` / `deploy:production` を使う。

---

## 4. GitHub Actions から自動デプロイする

ここまで通れば、あとは `develop` / `main` へのpushで自動デプロイできる。

### 4-0. ワークフローを配置する

GitHub App(Claude Code等)は `.github/workflows/` 配下をpushできないため、
YAMLは [`docs/ci/`](ci/README.md) にテンプレートとして置いてある。
**リポジトリオーナーが手元で1度だけコピーする。**

```bash
cp docs/ci/deploy.yml .github/workflows/deploy.yml
git add .github/workflows/deploy.yml
git commit -m "ci: enable backend deploy workflow"
```

### 4-1. APIトークンを作る

Cloudflare ダッシュボード > My Profile > **API Tokens** > Create Token。
テンプレート **"Edit Cloudflare Workers"** をベースに、以下の権限があること:

| 種別 | 権限 | 用途 |
| --- | --- | --- |
| Account | Workers Scripts : Edit | `wrangler deploy` |
| Account | D1 : Edit | マイグレーション適用 |
| Account | Workers KV Storage : Edit | KVバインディング |
| Account | Workers R2 Storage : Edit | R2バインディング |
| Account | Account Settings : Read | workers.dev のサブドメイン解決 |

### 4-2. リポジトリに登録する

Settings > Secrets and variables > Actions > **Secrets**:

| 名前 | 中身 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 4-1 で作ったトークン |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボード右側の Account ID |

develop と production でCloudflareアカウントを分けるなら、リポジトリ共通ではなく
Settings > **Environments** の `develop` / `production` にそれぞれ登録する
(ワークフローが `environment:` を指定しているので、環境側の値が優先される)。

### 4-3. production に承認を挟む(任意)

Settings > Environments > `production` > **Required reviewers** に自分を入れると、
`main` へのpushでデプロイが一旦止まり、GitHub上で承認してから流れる。

### ワークフローがやること

1. デプロイ先の環境のバインディングが埋まっているか確認する(`verify:bindings`)
2. `pnpm run verify`(lint / typecheck / シークレット走査 / テスト)
3. `wrangler d1 migrations apply --remote`
4. `wrangler deploy --env <target>`
5. `/health` を叩いて、名乗る環境名が一致するか確かめる

CI(`ci.yml`)と検査が重複するが、デプロイジョブは単体で完結させている。
CIが緑だった時点と実際にデプロイするコミットは別物になりうるため。

### 順番: **API を先、agent をあと**

新コアループ([ADR 0009](adr.md#adr-0009))を含む版は、この順でしか安全に出せない。

- **新しい agent × 古い API** → `/complete` が `practice_problem` を送るが、古い API の
  `completeSessionRequestSchema` は `.strict()` なので **400**。
  会話は成立するのに完了だけが落ち、生徒からは「終わらない」に見える。
- **古い agent × 新しい API** → `karte` を送ってくるが、新しい API はその欄を
  optional のまま受けて**捨てる**。復習問題が作られないだけで、セッションは完了する。

つまり**壊れない側は1つだけ**。API を先に出し、`/health` で名乗る環境を確かめてから
agent を入れ替えること。`karte` の欄は旧 agent が全部入れ替わったら消す。

コード変更なしで流し直したいとき(secretを入れ替えた後など)は、
Actions > Deploy (backend/api) > **Run workflow** から環境を選ぶ。

---

## 5. 運用

```bash
cd backend/api
pnpm run tail:develop        # ログを流し見る (wrangler tail)
pnpm run tail:production
```

**ロールバック**は Cloudflare ダッシュボード > Workers > 該当ワーカー >
Deployments から前のバージョンに戻すのが速い
(`wrangler rollback --env production` でも戻せる)。
**ただしD1のマイグレーションは戻らない。** 列を消す・型を変える類の変更は、
「足す → 両対応で動かす → 後で消す」の順に分けること。

### クローズドβのあいだ無料で開放する

`wrangler.toml` の2つの `vars` だけで切り替わる。**アプリ側の変更もリリースも要らない**。

| 変数 | 意味 |
| --- | --- |
| `BETA_OPEN_ACCESS_UNTIL` | 開放の期限(ISO8601)。**この時刻まで全員がPremium相当**。無いか読めない値なら通常営業 |
| `BETA_SECONDS_PER_DAY` | 開放中の1日の持ち時間(既定12000秒)。1回の長さは Premium と同じ最長20分 |

```bash
cd backend/api
# 期限を伸ばす/縮める → wrangler.toml を書き換えてデプロイするだけ
pnpm run deploy:production
```

なぜこれで足りるのか。**この期間にアプリを入れられるのは、Play の限定公開テストか
TestFlight の名簿に載っている人だけ**なので、「全員」と「テスター」が同じ集合になる。
端末IDを集めて1人ずつ付けて回る必要も、機種変更で付け直す必要も無い。

開放中は、判定を通る場所すべてが同じ答えになる(`lib/entitlement.ts` の
`hasPremiumAccess`)。復習の音声授業・学習プラン・親レポート・あと追い質問が開き、
**カルテ後のペイウォールも出ない** —— テスターは購入画面に一度も触れないので、
「無料」は導線として本当に無料になる。日次の上限に当たったときも
`fair_use_limit_reached`(=課金を勧めない文言)を返す。

注意:

- **一般公開の前に必ず消すこと。** 残っていると、課金できるのに誰も課金画面を見ない、
  という形でしか気づけない。期限を入れてあるのは、消し忘れても勝手に終わるようにするため。
- **`isPremiumNow` は変わらない。** β開放は「機能を開けてよいか」の判定で、
  支払いの記録ではない。RevenueCatのwebhook同期とTRANSFERの引き継ぎは、
  いままでどおり本当に払った人だけを見ている。
- **上限は外れない。** 使い放題と言っても LiveKit・STT・LLM・TTS の従量原価は
  テスターでも同じだけ動くので、`BETA_SECONDS_PER_DAY` が時間比例で異常利用を止める。
- テスターが自分から購入画面まで行くことは無いが、**Play Console の
  「ライセンステスト」にテスターのアカウントを入れておく**と、
  万一の購入もテスト購入(無課金)になる。

---

## 6. まわりの設定

APIを2環境に分けると、つながる側も2つ要る。

| | develop | production |
| --- | --- | --- |
| LiveKit | 開発用プロジェクト | 本番用プロジェクト |
| agent の `API_BASE_URL` | develop のワーカーURL | production のワーカーURL |
| agent の `INTERNAL_API_TOKEN` | develop のsecretと同じ値 | production のsecretと同じ値 |
| RevenueCat webhook | develop の `/v1/webhooks/revenuecat` | production の `/v1/webhooks/revenuecat` |
| Codemagic の `API_BASE_URL` | — | production のワーカーURL |

- **LiveKitのプロジェクトは分ける。** 同じプロジェクトを共有すると、develop の
  agent が本番のルームのジョブを拾いうる。`LIVEKIT_URL` / `API_KEY` / `API_SECRET`
  を環境ごとに別のものにして、agentもAPIも同じ組を見るようにする。
- **RevenueCatのwebhookは環境ごとに宛先を分ける。** Sandboxのイベントを本番の
  D1に書かないため。`REVENUECAT_WEBHOOK_AUTH` も別の値にする。
- **Codemagicのビルドは production を向ける。** TestFlightに出るビルドが
  develop のAPIを叩くと、テスターの操作が開発用D1に入る
  (変数グループ `mobile-dart-defines` の `API_BASE_URL`。[codemagic.md](ci/codemagic.md))。
  手元の `flutter run` は `--dart-define=API_BASE_URL=http://localhost:8787`。

---

## 7. 動かなくなったときに見るもの

バックエンドは**静かに壊れる**(アプリ側には「聞いています」のまま止まる、
「カルテが出ない」としか出ない)。ログは1行1JSONなので、フィールドで絞る。

```bash
pnpm --filter @ai-sensei/api tail:develop     # Workers Logs を流し見る
```

| 症状 | 見るもの |
| --- | --- |
| 写真を撮ったあと進まない | `session_created` が出ているか。無ければ `photo_analysis_failed` / `session_rejected` |
| 会話が始まらない(後輩が来ない) | agent側の `job_started`。無ければディスパッチ(`session_created` の `agent_dispatch`)を疑う |
| 会話はできたが3日後に通知が来ない | agent側の `practice_problem_declined` / `practice_problem_failed` / `complete_failed`、API側の `complete_unauthorized` / `session_completed`(`practice_problem` が false)/ `practice_schedule_failed` |
| ユーザーからの問い合わせ | レスポンスの `x-trace-id`。この値でログを引く |

`SENTRY_DSN` を入れてあれば、`unhandled_error` と各 `*_failed` はSentryにも届く。
APIとagentは `session_id` を共通のキーにしているので、両方のログを並べられる。

---

## まだやっていないこと

- **独自ドメイン。** いまは両環境とも `*.workers.dev`。production に独自ドメインを
  当てたら `wrangler.toml` の `[env.production]` を `workers_dev = false` にして
  `[[env.production.routes]]` を足す(workers.dev のURLを残すと、そちらが
  野良のエンドポイントとして生き続ける)。
- **トレース。** Sentryは入れたがエラーだけ(`tracesSampleRate: 0`)。
  どこで時間を使っているかは、いまは `http_request` の `duration_ms` で見る。
