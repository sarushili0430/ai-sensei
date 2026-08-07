# ai-sensei

**「わかったつもり」を、声に出して説明させて見つけるアプリ。**

ノートを撮ると、後輩AIが「え、なんでここで判別式使うんですか?」
「なんでここ、過去形じゃなくて現在完了にしたんですか?」と聞いてくる。
答えは教えない。説明しているうちに、自分でも気づいていなかった **理解の穴** が見つかる。
見つかった穴は「カルテ」に残り、翌日・3日後・7日後に後輩がもう一度たずねてくる。

- ターゲット: 日本の高校生
- 対象科目: **高校数学**(数I・A・II・B・III・C、新課程)と **英文法**。
  1セッションで扱うのは1科目で、どちらかは写真から自動で判定する(ユーザーは選ばない)
- 学習科学の背景: 自己説明効果(self-explanation effect)とプロテジェ効果(teachable agent)
- [RevenueCat Shipaton 2026](https://shipaton.revenuecat.com/) 提出プロジェクト(Next Gen Award 併願のため初日からpublic + MIT)

何を作っていて何を作らないかの合意は [`docs/inception-deck.md`](docs/inception-deck.md) にまとめてあります
(エレベーターピッチ・やらないことリスト・トレードオフスライダー)。スプリントの入口で読んでください。
企画・設計の一次情報は [`docs/handoff_to_opus.md`](docs/handoff_to_opus.md) にあります。
画面設計と**画面遷移図**は [`docs/wireframe_v1.html`](docs/wireframe_v1.html)、ビジュアル方針は
[`docs/design_direction_v0.html`](docs/design_direction_v0.html) を参照してください
([`wireframe_v0.html`](docs/wireframe_v0.html) は差分を追うために残してある旧版です)。
アプリアイコン・ストア掲載スクリーンショット・App Store提出メタデータ(説明文・キーワード・審査メモ)も
同じ `design_direction_v0.html` の後半にまとめてあります。スクショの実物は
[`docs/store/screenshots/`](docs/store/screenshots)、生成はどちらも
`apps/mobile/tool/` のスクリプトが行い、**絵の正はコード**です(画像を直接描き直さないこと)。

---

## リポジトリ構成

```
apps/mobile/        Flutter (iOS先行) + Riverpod 3 + livekit_client
backend/api/        Cloudflare Workers + Hono — セッション作成 / カルテ保存 / 課金webhook
backend/agent/      LiveKit Agents — VAD・STT・LLM・TTSの会話パイプライン(後輩キャラ)
packages/contract/  APIとカルテのスキーマ + fixture(モバイル/サーバ双方で契約を検証)
packages/curriculum/カリキュラムマップ(数学・英文法。質問生成の許可リスト兼、穴のタグ)
packages/guardrail/ topic_idホワイトリスト照合・数式音声の正規化などの純関数
prompts/            システムプロンプトとfew-shot(科目ごとに差し替える対を含む)
docs/               企画資料・ワイヤーフレーム・ADR
scripts/            リポジトリ全体の検証スクリプト
```

TypeScript側(`backend/`・`packages/`)は pnpm workspaces でひとつに束ねています。
Flutter側は `apps/mobile` で完結し、両者は `packages/contract` のスキーマとfixtureで接続します。

## セットアップ

### 0. 前提

| ツール          | バージョン | 用途                     |
| --------------- | ---------- | ------------------------ |
| Node.js         | 22.6 以上  | backend / packages       |
| pnpm            | 10 以上    | 同上(`corepack enable` で入る) |
| Flutter         | 3.44.8     | apps/mobile(`.fvmrc` で固定。fvm推奨) |
| Xcode           | 16 以上    | iOSビルド(macOSのみ)   |

### 1. 依存のインストール

```bash
git clone https://github.com/sarushili0430/ai-sensei.git
cd ai-sensei
pnpm install         # TypeScript側をまとめて解決
```

### 2. 環境変数

**このリポジトリはpublicです。実際の鍵は絶対にコミットしないでください。**
テンプレートは**デプロイ単位ごと**に分かれています。

```bash
cp backend/api/.dev.vars.example        backend/api/.dev.vars           # wrangler dev が読む
cp backend/agent/.env.example           backend/agent/.env              # LiveKit Agents が読む
cp apps/mobile/dart_defines.example.env apps/mobile/dart_defines.env    # --dart-define-from-file
```

| テンプレート | 中身 |
| --- | --- |
| `backend/api/.dev.vars.example` | LiveKit / Vision LLM / OneSignal / RevenueCat webhook / 内部トークン |
| `backend/agent/.env.example` | LiveKit / 会話・カルテのLLM / STT / TTS / 内部トークン |
| `apps/mobile/dart_defines.example.env` | **公開値のみ**(APIのURL・RevenueCat公開鍵・OneSignal App ID・Sentry DSN・規約URL・報告先メール) |

課金まわりのダッシュボード設定とアプリ側の噛み合わせは
[`docs/revenuecat.md`](docs/revenuecat.md) にまとめてあります。
鍵を渡さないビルドでは課金機能ごと無効になるので、`flutter test` と CI は
RevenueCat の設定なしで通ります。

`--dart-define` の値はビルド成果物に埋め込まれ、逆アセンブルで読めます。
**秘密鍵はモバイル側に置かないでください。**

本番の秘匿値は `wrangler secret put <NAME> --env <develop|production>` と
LiveKit側の環境設定に、**環境ごとに別々**で登録します([`docs/deploy.md`](docs/deploy.md))。
コミット前に走査するには:

```bash
pnpm run verify:secrets
```

### 3. 開発サーバ

```bash
pnpm --filter @ai-sensei/api dev     # backend/api  → http://localhost:8787
pnpm --filter @ai-sensei/agent dev   # backend/agent (LiveKitのルームに接続して待機)

cd apps/mobile
fvm install                                # .fvmrc のバージョンを取得
fvm flutter pub get
fvm dart run build_runner build            # freezed / riverpod の生成物
fvm flutter run --dart-define=API_BASE_URL=http://localhost:8787
```

> 生成物(`*.freezed.dart` / `*.g.dart`)はコミットしません。
> クローン直後は `build_runner build` を一度回してください。

## テスト

```bash
pnpm run verify       # lint + typecheck + シークレット走査 + ユニットテスト
pnpm run lint         # Biome(lint + format検査)のみ
pnpm run format       # Biomeで整形する(--write)
pnpm test             # vitest のみ

cd apps/mobile && fvm flutter test   # 契約fixture + ウィジェット + golden
```

### コミット前のlint(lefthook)

git hooks は [lefthook](https://lefthook.dev/) で管理していて、
`pnpm install` を一度走らせれば入ります(`prepare` が `lefthook install` を呼ぶ)。
設定は**見る対象ごとに分けて**置いてあり、ルートの `lefthook.yml` が読み込みます。

| 設定ファイル | 走る条件 | 中身 |
| --- | --- | --- |
| `backend/lefthook.yml` | `backend/` 配下の `.ts/.js/.json` がステージされたとき | `biome ci <変更ファイル>` |
| `apps/mobile/lefthook.yml` | `apps/mobile/` 配下の `.dart/.yaml` がステージされたとき | `flutter analyze` |

**pre-commitで見るのはlintだけ**です。typecheck・テスト・ビルドはCIに任せています
(コミットのたびに数十秒待たされると、hookを外す方向に力が働くため)。
触っていない側は走りません。backendだけのコミットでFlutterは要りません。

```bash
pnpm exec lefthook run pre-commit    # 手動で走らせる
LEFTHOOK=0 git commit ...            # 一時的に飛ばす
```

`apps/mobile` 側は `flutter analyze` なので、生成物(`*.g.dart` / `*.freezed.dart`)が
無いと落ちます。クローン直後は先に `build_runner build` を回してください。

CIとデプロイのワークフローのテンプレートは [`docs/ci/`](docs/ci/README.md) にあります
(GitHub Appは `.github/workflows/` へpushできないため、初回だけ手元でコピーが必要です)。

Claude Code on the web で開くときは、`.claude/hooks/session-start.sh` が
セッション開始時に走り、pnpm・Flutter SDK(`.fvmrc` のバージョン)・
コード生成までを済ませます。**開いた時点で lint とテストが通る状態**になります。

Biomeがlintと整形の両方を担当します(ESLint + Prettierは入れていません)。

テスト方針は「①純関数ユニット(ガードレール照合・数式正規化・間隔反復スケジューラ・
穴/連続日数の集計・contract fixtureのパース)」と「②主要画面のgolden test」の2本立てです。
golden testは主要画面ぶん11枚あり(オンボーディングは4枚のうち3枚、
ホームと復習は状態違いを2枚ずつ撮る)、**Linuxのラスタライズを正**として
CIで生成します(`apps/mobile/test/golden/README.md`)。
E2Eは書かず、TestFlightでの手動確認に割り切っています。

アニメーションは端末の「アニメーションを減らす」設定を必ず通します
([ADR 0004](docs/adr/0004-motion-and-onboarding.md))。テストもその経路で回るので、
ループするアニメーションを足して経路を通し忘れると `pumpAndSettle` が返らず、
テストが止まって気づけます。

依存の更新は Renovate(`renovate.json`)。ソロ開発なので週1にまとめ、
同時に開くPRを3本までに絞っています。FlutterのSDK更新だけは
ダッシュボードでの承認制です(提出直前に上がってこないように)。

## デプロイ

`backend/api` は Cloudflare Workers に **develop / production の2本**で載せます。

| | develop | production |
| --- | --- | --- |
| ブランチ | `develop` | `main` |
| ワーカー | `ai-sensei-api-develop` | `ai-sensei-api-production` |
| D1 / R2 / KV | 専用のリソース | 専用のリソース |

バインディング名(`DB`/`PHOTOS`/`METER`)だけを揃えて実体を分けているので、
コードは環境を意識しません。`develop`/`main` へのpushでGitHub Actionsが
マイグレーション → デプロイ → `/health` の確認まで行います。

リソースの作成・secretの登録・APIトークンの権限は [`docs/deploy.md`](docs/deploy.md)。
`apps/mobile` の配布は Codemagic 側です([`docs/ci/codemagic.md`](docs/ci/codemagic.md))。

`backend/agent`(LiveKit Agents)は**常駐するコンテナ**で、LiveKit Cloud の
エージェントホスティングに載せます([`docs/deploy-agent.md`](docs/deploy-agent.md))。
**`Dockerfile` がリポジトリのルートにあるのは意図的**です(agentが `packages/*` を
`workspace:*` で参照しているのと、`lk` が作業ディレクトリ直下の `Dockerfile` しか
読まないため。[ADR 0002 の追記](docs/adr/0002-agent-runtime.md))。
同じイメージはどのコンテナホストでも動きます。

> **LiveKitのプロジェクトは環境ごとに分けます**(同じプロジェクトを共有すると
> 開発用のagentが本番のルームのジョブを拾いうるため)。

## アーキテクチャ

```
Flutter app ──HTTPS──▶ backend/api ──▶ LiveKit room 作成 + agent 起動
     │                    │  写真をVision LLMで解析し、単元判定と質問方針を作る
     │                    │  ストレージ: R2(写真) / DB: D1 / メータリング: KV
     └──WebRTC────────▶ agent
                          VAD → 日本語ストリーミングSTT → LLM(後輩ペルソナ)
                          → TTS。割り込み対応。終了時にtranscriptからカルテを生成し
                          backend/api の /v1/sessions/{id}/complete へPOST
                          → OneSignalで翌日/3日後/7日後の再説明プッシュを予約
```

質問生成には二重のガードレールがあります。
プロンプト側で「ノート写真に写っている内容 ∩ カリキュラムマップの範囲」に限定し、
サーバ側で出力の `topic_id` をホワイトリスト照合して、外れたものは再生成させます。

## 設計上の約束(実装時に守ること)

1. **答えを教えない。** 解答・解説の生成は機能として持たない。
2. **点数を出さない。** 数えるのは「連続日数」と「埋めた穴の数」だけ。
3. **パスを恥にしない。** 説明できなかったことは、そのまま穴として価値化する。
4. **煽らない。** 通知もペイウォールも、後輩からのお願いとして書く。

## ライセンス

[MIT](LICENSE)
