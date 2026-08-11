# apps/lp — ランディングページ

カタルテ(ai-sensei)の紹介ページ。**日本語 (`index.html`) と英語 (`en/index.html`) の2枚で1組**です。

```
apps/lp/
  index.html      日本語
  en/index.html   English
  styles.css      2枚で共有する唯一のスタイルシート
```

想定している使い道は3つです。

| 用途 | 使う場所 |
| --- | --- |
| マーケティングURL | App Store Connect(任意) |
| サポートURL | App Store Connect(**必須**。いまは GitHub Issues を窓口にしている) |
| 提出資料からの導線 | Shipaton / Devpost / #BuildInPublic の投稿 |

## 作りの前提

- **ビルド工程なし・JavaScriptなし。** 素の HTML と CSS だけで、どこに置いても動きます。
  pnpm workspace には入っていません(`pnpm-workspace.yaml` は `packages/*` と `backend/*` だけ)。
- **色・角丸・ボタンの厚みは `apps/mobile/lib/src/theme/tokens.dart` が正**で、`styles.css` はその写し。
  ずらすとストアのスクショと並んだときに別プロダクトに見えます。変えるときは先に tokens.dart を見ること。
- **端末の画面はCSSで組んでいます**(`docs/store/screenshots/` の画像を貼っていません)。
  画像を貼ると生成物と二重管理になり、片方が必ず古くなるためです。絵の正はコード、という
  リポジトリの方針([README](../../README.md))に合わせています。
- **文言はアプリの実装から取っています。** 見出し・板書の式・カルテの1行・ペイウォールの項目は
  `apps/mobile/lib/src/l10n/strings.dart` と同じ言い回しです。**アプリの文言を変えたらここも直す。**
- **価格を書いていません。** 金額は RevenueCat の Offering から引く実装なので、ページに焼くと
  ダッシュボードで値段を変えた瞬間にストアの決済画面と食い違います(`strings.dart` の
  `paywallPricePending` と同じ判断)。
- 「アニメーションを減らす」設定を通します([ADR 0004](../../docs/adr/0004-motion-and-onboarding.md))。

## 手元で見る

ビルドは要りません。ファイルを直接開くか、静的サーバを立ててください
(`en/` へのリンクを踏むならサーバのほうが確実です)。

```bash
python3 -m http.server 4173 --directory apps/lp
# → http://localhost:4173/      日本語
# → http://localhost:4173/en/   English
```

## 公開する

`apps/lp` をそのまま publish directory にすれば、どのホスティングでも動きます。

```bash
# Cloudflare Pages(backend/api と同じアカウントに置く場合)
pnpm dlx wrangler pages deploy apps/lp --project-name ai-sensei-lp
```

GitHub Pages を使う場合は、Pages のソースに `apps/lp` を指すワークフローを足してください
(`.github/workflows/` へは GitHub App からpushできないので、テンプレートを置く場所は
[`docs/ci/`](../../docs/ci/README.md) に合わせること)。

## 公開前に埋めるもの

`docs/design_direction_v0.html` の「提出前に埋めるもの」と対になっています。
**無いものへのリンクは置かない**方針なので、値が決まるまでページには出していません。

- [ ] 公開ドメイン → `<link rel="alternate" hreflang>` と `og:url` を絶対URLに直す(いまは相対)
- [ ] `PRIVACY_POLICY_URL` / `TERMS_URL` → フッタに追加(HTMLにコメントで場所を書いてあります)
- [ ] `SUPPORT_EMAIL` → フッタの問い合わせ先に追加(いまは GitHub Issues のみ)
- [ ] App Store の配信開始 → ヒーローと締めの「App Store で配信予定」を実際のバッジとリンクに差し替え
- [ ] OGP画像(`og:image`)。1200×630。`apps/mobile/tool/` と同じく**コードから生成する**こと
