# ai-sensei

**数学の「わかったつもり」を、声に出して説明させて見つけるアプリ。**

ノートを撮ると、後輩AIが「え、なんでここで判別式使うんですか?」と聞いてくる。
答えは教えない。説明しているうちに、自分でも気づいていなかった **理解の穴** が見つかる。
見つかった穴は「カルテ」に残り、翌日・3日後・7日後に後輩がもう一度たずねてくる。

- ターゲット: 日本の高校生 / 対象科目: 高校数学(数I・A・II・B・III・C、新課程)
- 学習科学の背景: 自己説明効果(self-explanation effect)とプロテジェ効果(teachable agent)
- [RevenueCat Shipaton 2026](https://shipaton.revenuecat.com/) 提出プロジェクト(Next Gen Award 併願のため初日からpublic + MIT)

企画・設計の一次情報は [`docs/handoff_to_opus.md`](docs/handoff_to_opus.md) にあります。
画面設計は [`docs/wireframe_v0.html`](docs/wireframe_v0.html)、ビジュアル方針は
[`docs/design_direction_v0.html`](docs/design_direction_v0.html) を参照してください。

---

## リポジトリ構成

```
apps/mobile/        Flutter (iOS先行) + Riverpod 3 + livekit_client
workers/api/        Cloudflare Workers + Hono — セッション作成 / カルテ保存 / 課金webhook
agent/              LiveKit Agents — VAD・STT・LLM・TTSの会話パイプライン(後輩キャラ)
packages/contract/  APIとカルテのスキーマ + fixture(モバイル/サーバ双方で契約を検証)
packages/curriculum/高校数学カリキュラムマップ(純JSON。質問生成の許可リスト兼、穴のタグ)
packages/guardrail/ topic_idホワイトリスト照合・数式音声の正規化などの純関数
prompts/            システムプロンプトとfew-shot(差分レビューできるようにバージョン管理)
docs/               企画資料・ワイヤーフレーム・ADR
scripts/            リポジトリ全体の検証スクリプト
```

TypeScript側(`workers/`・`agent/`・`packages/`)は npm workspaces でひとつに束ねています。
Flutter側は `apps/mobile` で完結し、両者は `packages/contract` のスキーマとfixtureで接続します。

## セットアップ

### 0. 前提

| ツール          | バージョン | 用途                     |
| --------------- | ---------- | ------------------------ |
| Node.js         | 22 以上    | workers / agent / packages |
| Flutter         | 3.27 以上  | apps/mobile              |
| Xcode           | 16 以上    | iOSビルド(macOSのみ)   |

### 1. 依存のインストール

```bash
git clone https://github.com/sarushili0430/ai-sensei.git
cd ai-sensei
npm install          # TypeScript側をまとめて解決
```

### 2. 環境変数

**このリポジトリはpublicです。実際の鍵は絶対にコミットしないでください。**
テンプレートは [`.env.example`](.env.example) にあります。

```bash
cp .env.example workers/api/.dev.vars   # wrangler dev が読む
cp .env.example agent/.env              # LiveKit Agents が読む
```

本番の秘匿値は `wrangler secret put <NAME>` とLiveKit側の環境設定に登録します。
コミット前に走査するには:

```bash
npm run verify:secrets
```

### 3. 開発サーバ

```bash
npm run -w @ai-sensei/api dev     # workers/api  → http://localhost:8787
npm run -w @ai-sensei/agent dev   # agent (LiveKitのルームに接続して待機)

cd apps/mobile
flutter pub get
flutter run --dart-define=API_BASE_URL=http://localhost:8787
```

> `apps/mobile` は codegen なしで動きます(`build_runner` は現時点では不要)。
> 理由と、codegenへ寄せる場合の置き換え方は `apps/mobile/README.md` にあります。

## テスト

```bash
npm run verify        # typecheck + シークレット走査 + ユニットテスト(TypeScript側)
npm test              # vitest のみ

cd apps/mobile && flutter test    # 契約fixtureの検証 + ウィジェットテスト
```

CIワークフローのテンプレートは [`docs/ci/`](docs/ci/README.md) にあります
(GitHub Appは `.github/workflows/` へpushできないため、初回だけ手元でコピーが必要です)。

テスト方針は「①純関数ユニット(ガードレール照合・数式正規化・間隔反復スケジューラ・
穴/連続日数の集計・contract fixtureのパース)」と「②主要画面のgolden test」の2本立てです。
golden testはフォント配置後に入れます(`apps/mobile/README.md`)。
E2Eは書かず、TestFlightでの手動確認に割り切っています。

## アーキテクチャ

```
Flutter app ──HTTPS──▶ workers/api ──▶ LiveKit room 作成 + agent 起動
     │                    │  写真をVision LLMで解析し、単元判定と質問方針を作る
     │                    │  ストレージ: R2(写真) / DB: D1 / メータリング: KV
     └──WebRTC────────▶ agent
                          VAD → 日本語ストリーミングSTT → LLM(後輩ペルソナ)
                          → TTS。割り込み対応。終了時にtranscriptからカルテを生成し
                          workers/api の /v1/sessions/{id}/complete へPOST
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
