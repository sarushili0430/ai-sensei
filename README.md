# ai-sensei

**答えを教える。そのあと、あなたに教え返してもらう。**

わからない問題を撮ると(ノートがあれば一緒に)、先輩AIが板書つきで教えてくれる。数式や計算は板書に書き、声は
「ここ、Dを見てほしいんだけど — プラスだよね。だから?」と問いかけるだけ。
教わったらすぐ、「じゃあ今の、説明してみて」と**教え返す**。説明に詰まった場所が、
自分でも気づいていなかった **理解の穴** として「カルテ」に残り、1日・3日・7日後に
もう一度たずねます。

- ターゲット: 日本の中高生 / 対象科目: 中学数学・高校数学(数I・A・II・B・III・C)・中学英語・高校英語
- 日本語と英語の2言語。**海外の学習者には海外の課程**(Algebra 1 / Geometry /
  Algebra 2 / Precalculus / Calculus / Statistics)を出す
  ([ADR 0005](docs/adr.md#adr-0005))
- 学習科学の背景: 自己説明効果(self-explanation effect)とプロテジェ効果(teachable agent)
- [RevenueCat Shipaton 2026](https://shipaton.revenuecat.com/) 提出プロジェクト(Next Gen Award 併願のため初日からpublic + MIT)

何を作っていて何を作らないかの合意は [`docs/inception-deck.md`](docs/inception-deck.md) にまとめてあります
(エレベーターピッチ・やらないことリスト・トレードオフスライダー)。スプリントの入口で読んでください。
2026-08-09に「先輩AIが板書つきで教える → 教え返させる」へ差し替えた経緯と設計は
[`docs/pivot_plan_v1.md`](docs/pivot_plan_v1.md) にまとめてあります。
画面設計と**画面遷移図**は [`docs/wireframe_v1.html`](docs/wireframe_v1.html)、ビジュアル方針は
[`docs/design_direction_v0.html`](docs/design_direction_v0.html) を参照してください。
アプリアイコン・ストア掲載スクリーンショット・App Store提出メタデータ(説明文・キーワード・審査メモ)も
同じ `design_direction_v0.html` の後半にまとめてあります。スクショの実物は
[`docs/store/screenshots/`](docs/store/screenshots)、生成はどちらも
`apps/mobile/tool/` のスクリプトが行い、**絵の正はコード**です(画像を直接描き直さないこと)。
Google Play の掲載テキスト(短い説明・詳しい説明の日英)・ストアアイコン512px・
フィーチャーグラフィック・スマホ/7インチ/10インチのスクショは
[`docs/store/play_listing.md`](docs/store/play_listing.md) にまとめてあります。

---

## リポジトリ構成

```
apps/mobile/        Flutter (iOS先行) + Riverpod 3 + livekit_client
apps/lp/            紹介ページ(日英2枚・素のHTML/CSS)。Cloudflare Workers の静的アセットとして配信
apps/tuner/         プロンプトチューニング用のweb画面(写真→音声→板書)。**開発専用で配信しない**
backend/api/        Cloudflare Workers + Hono — セッション作成 / カルテ保存 / 課金webhook
backend/agent/      LiveKit Agents — VAD・STT・LLM・TTSの会話パイプライン + 板書生成(先輩キャラ)
packages/contract/  APIとカルテと板書(`board.ts`)のスキーマ + fixture(モバイル/サーバ双方で契約を検証)
packages/curriculum/カリキュラムマップ(純JSON。中学/高校の数学と英語、海外の課程を別に持つ)
packages/guardrail/ topic_idホワイトリスト照合・板書LaTeXのコマンド照合・数式音声の正規化などの純関数
prompts/            システムプロンプトとfew-shot(`<id>.<locale>.md`。日英で別本。板書つき授業は`senpai_board.*.md`)
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

**プロンプトを直すときは、Flutterを立ち上げずに済みます。**
`apps/tuner` が同じAPI・同じLiveKitの部屋・同じ板書の検査を web で回すので、
写真を入れて授業を1本流し、板書・字幕・agentに渡した文脈・カルテ・所要時間を
1画面で見られます([`apps/tuner/README.md`](apps/tuner/README.md))。

```bash
pnpm --filter @ai-sensei/tuner dev   # http://localhost:5273(api と agent も動かしておく)
```

`/debug` は**授業を回さない側**で、写真も鍵も要りません。板書のJSONを貼って
描けるかを見る、保存した試行を封筒から再生する、プロンプトの本文と差し込み変数を読む、
の3つに使います。

`prompts/*.md` を直したら **`pnpm --filter @ai-sensei/prompts generate` と
agentの再起動**が要ります(常駐プロセスが古い本文を持つため)。
忘れたまま観察し続けないよう、tunerの画面が食い違いを帯で知らせます。

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
([ADR 0004](docs/adr.md#adr-0004))。テストもその経路で回るので、
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
読まないため。[ADR 0002 の追記](docs/adr.md#adr-0002))。
同じイメージはどのコンテナホストでも動きます。

> **LiveKitのプロジェクトは環境ごとに分けます**(同じプロジェクトを共有すると
> 開発用のagentが本番のルームのジョブを拾いうるため)。

## アーキテクチャ

```
Flutter app ──HTTPS──▶ backend/api ──▶ LiveKit room 作成 + agent 起動
     │                    │  写真をVision LLMで解析し、単元判定と質問方針を作る(まだ数えない)
     │                    │  部屋を開くのは「はじめる」を押したとき = 1日の回数もそこで数える
     │                    │  ストレージ: R2(写真) / DB: D1 / メータリング: KV
     └──WebRTC────────▶ agent
                          VAD → 日本語ストリーミングSTT → LLM(先輩ペルソナ)が
                          {speech, board} をストリーミング生成。手順が1つ完成するたびに
                          board を LiveKit Text Streams で送信し、直後に speech を TTS
                          → 割り込み対応。終了時にtranscriptからカルテを生成し
                          backend/api の /v1/sessions/{id}/complete へPOST
                          → OneSignalで翌日/3日後/7日後の再訪プッシュを予約
```

先輩は「教える」区間だけ声で話し、数式・計算・図は板書として画面に積みます
(数式を音声で読み上げません)。Flutter側は受信した手順を1行ずつ積み上げ、
前の手順は消さずに残します。板書要素(LaTeX・グラフ・三角形・円)のスキーマは
`packages/contract/src/board.ts` にあり、モバイルとagentの両方が同じ形を検証します。

質問生成には二重のガードレールがあります。
プロンプト側で「ノート写真に写っている内容 ∩ カリキュラムマップの範囲」に限定し、
サーバ側で出力の `topic_id` をホワイトリスト照合して、外れたものは再生成させます。
板書のLaTeXも同様に、`packages/guardrail` でコマンドをホワイトリスト照合してから送信し、
描画できない構文を弾きます。

## 2つの課程(日本 / 海外)

`locale` は写真解析からカルテ・通知まで一本で通します。**言語だけでなく分類も
切り替わります** — 海外の学習者に「数学II / 図形と方程式」と出しても、
自分の教科書の目次と一致しないので穴のタグとして機能しないためです。

| | `ja` | `en` |
| --- | --- | --- |
| カリキュラム | 数学I〜C(新課程) | Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics |
| topic_id | `M2-ZUKEI-ENCHOKU` | `A2-COORD-CIRCLE` |
| プロンプト | `prompts/*.ja.md` | `prompts/*.en.md` |
| STT / TTS | 日本語モデル | 英語モデル |
| ガードレール | 答えの漏れ・範囲外の語・数式音声を日本語で | 同じものを英語で |

穴(hole)に付いた `topic_id` の接頭辞が、その穴の言語を決めます。復習の通知と
復習画面の一行は端末の言語設定ではなくこれに従うので、日本語で説明した穴が
英語の通知で届くことはありません([ADR 0005](docs/adr.md#adr-0005))。

## 設計上の約束(実装時に守ること)

1. **教える。そのあと教え返させる。** 先輩が板書つきで教え、その場で「説明してみて」と聞き返す。
2. **点数を出さない。** 数えるのは「連続日数」と「埋めた穴の数」だけ。
3. **パスを恥にしない。** 説明できなかったことは、そのまま穴として価値化する。
4. **煽らない。** 通知もペイウォールも、先輩の判断として書く。数字は見せず、命令や催促にもしない。

## ライセンス

[MIT](LICENSE)
