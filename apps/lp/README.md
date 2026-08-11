# apps/lp — ランディングページ

カタルテ(ai-sensei)の紹介ページ。**日本語 (`index.html`) と英語 (`en/index.html`) の2枚で1組**です。

```
apps/lp/
  wrangler.jsonc         Cloudflare Workers(静的アセット)の設定
  package.json           deploy / dev のスクリプト
  public/                ここだけが公開される
    index.html           日本語
    en/index.html        English
    styles.css           2枚で共有する唯一のスタイルシート
```

**サイトに出すものは `public/` の中だけに置くこと。** `wrangler.jsonc` の
`assets.directory` が `./public` を指しているので、ここから外に置いたファイルは
配信されません(逆に、`public/` に置いたものは全部そのまま公開されます)。

想定している使い道は3つです。

| 用途 | 使う場所 |
| --- | --- |
| マーケティングURL | App Store Connect(任意) |
| サポートURL | App Store Connect(**必須**。いまは GitHub Issues を窓口にしている) |
| 提出資料からの導線 | Shipaton / Devpost / #BuildInPublic の投稿 |

## 作りの前提

- **ビルド工程なし・JavaScriptなし。** 素の HTML と CSS だけで、どこに置いても動きます。
  wrangler は配信のために使っているだけで、ビルドはしません
  (pnpm workspace に入っているのは、`pnpm --filter` から deploy を叩くためです)。
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

```bash
pnpm --filter @ai-sensei/lp dev
# → http://localhost:8787/      日本語
# → http://localhost:8787/en/   English
```

wrangler を通すと `/en` → `/en/` の寄せ方まで本番と同じになります。
それが要らないなら、素の静的サーバでも見られます。

```bash
python3 -m http.server 4173 --directory apps/lp/public
```

## 公開する

```bash
pnpm --filter @ai-sensei/lp exec wrangler login   # 初回だけ
pnpm --filter @ai-sensei/lp deploy
# → https://ai-sensei-lp.<subdomain>.workers.dev
```

`build:check`(`wrangler deploy --dry-run`)で、設定とアップロード対象だけを先に確かめられます。
**上げる前に必ず一度は流すこと** —— `public/` に置いたものは全部そのまま公開されるので、
アップロード対象のファイル数が想定と合っているかを、ここで見ます。

環境は分けていません。理由と、公開前に中身を見たいときの `wrangler versions upload` は
[`wrangler.jsonc`](wrangler.jsonc) の冒頭に書いてあります。

独自ドメインを当てるときは `wrangler.jsonc` の `workers_dev` を `false` にして
`routes` を足してください(workers.dev のURLを残すと、そちらが野良のURLとして生き続けます)。
自動デプロイを組むなら、ワークフローの置き場所は
[`docs/ci/`](../../docs/ci/README.md) に合わせること(`.github/workflows/` へは
GitHub App からpushできないため)。

## 公開前に埋めるもの

`docs/design_direction_v0.html` の「提出前に埋めるもの」と対になっています。
**無いものへのリンクは置かない**方針なので、値が決まるまでページには出していません。

- [ ] 公開ドメイン → `<link rel="alternate" hreflang>` と `og:url` を絶対URLに直す(いまは相対)
- [ ] `PRIVACY_POLICY_URL` / `TERMS_URL` → フッタに追加(HTMLにコメントで場所を書いてあります)
- [ ] `SUPPORT_EMAIL` → フッタの問い合わせ先に追加(いまは GitHub Issues のみ)
- [ ] `public/404.html` → 足したら `wrangler.jsonc` の `not_found_handling` を `"404-page"` に
- [ ] App Store の配信開始 → ヒーローと締めの「App Store で配信予定」を実際のバッジとリンクに差し替え
- [ ] OGP画像(`og:image`)。1200×630。`apps/mobile/tool/` と同じく**コードから生成する**こと
