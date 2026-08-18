# apps/lp — ランディングページ

カタルテ(ai-sensei)の紹介ページ。**日本語 (`index.html`) と英語 (`en/index.html`) の2枚で1組**です。

```
apps/lp/
  wrangler.jsonc         Cloudflare Workers(静的アセット)の設定
  package.json           deploy / dev のスクリプト
  public/                ここだけが公開される
    index.html           日本語
    en/index.html        English
    beta/index.html      クローズドベータの参加手順(日本語)
    en/beta/index.html   同(English)
    styles.css           全ページで共有する唯一のスタイルシート
```

**サイトに出すものは `public/` の中だけに置くこと。** `wrangler.jsonc` の
`assets.directory` が `./public` を指しているので、ここから外に置いたファイルは
配信されません(逆に、`public/` に置いたものは全部そのまま公開されます)。

想定している使い道は4つです。

| 用途 | 使う場所 |
| --- | --- |
| マーケティングURL | App Store Connect(任意) |
| サポートURL | App Store Connect / Google Play Console(**必須**。いまは GitHub Issues を窓口にしている) |
| 提出資料からの導線 | Shipaton / Devpost / #BuildInPublic の投稿 |
| クローズドテストのテスター募集 | `public/beta/`。SNS・学校・知人へ配るURLはここ1本にする |

**テスターの入口は Google グループ(`ai-sensei@googlegroups.com`)だけ。**
このグループが Play Console に登録したテスター名簿そのものなので、
**アドレスを変えるとテスターが全員まとめて外れます**(12人/14日のカウントも切れる)。
グループ側の設定と Play Console 側の紐づけは
[`docs/ci/store-setup.md`](../../docs/ci/store-setup.md) 2-4-1。

**LPの `#beta` と `public/beta/` で役割を分けています。**
`#beta` は「参加するかどうかを決める材料」(費用・お願いすること・何が開発者に見えるか)まで。
**①グループに参加 ②Playの参加用URLを押す、という手順は `public/beta/` にだけ書く。**
両方に書くと、Playのリリース状況で変わる手順が2箇所に散って必ず片方が古くなります。

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
- 「アニメーションを減らす」設定を通します([ADR 0004](../../docs/adr.md#adr-0004))。

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
pnpm --filter @ai-sensei/lp deploy:production
# → https://ai-sensei-lp.<subdomain>.workers.dev
```

> **`deploy` という名前にはできない。** `pnpm deploy` は pnpm 自身の組み込みコマンドで、
> 同名のスクリプトがあっても組み込みが勝ちます。`pnpm --filter @ai-sensei/lp deploy` は
> `ERR_PNPM_INVALID_DEPLOY_TARGET This command requires one parameter` で落ちます。
> `backend/api` が `deploy:develop` / `deploy:production` なのも同じ理由です。
> (`run` を挟めば組み込みは避けられますが、それを知らない人が素で `deploy` と打つと
> 同じところで詰まるので、名前のほうを衝突しないものにしてあります。)
>
> **CI(Cloudflare Workers Builds など)のデプロイコマンドにも、同じ名前を入れること。**
> ここが `pnpm --filter @ai-sensei/lp deploy` のままだと、ビルドは通ってデプロイだけが落ちます。

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
- [ ] **`public/privacy/` と `public/terms/` は雛形。** 弁護士のレビューを受けて差し替える。
      各ページ冒頭の `.legal-draft` ブロックと、黄色でマークした `<span class="fill">` が
      未確定の箇所(運営者名・所在地・お問い合わせ先・制定日・保存期間・管轄裁判所)。
      **`fill` が1つでも残っているうちは公開しない**
- [ ] **公開する正を1つに決める。** アプリとストアの申告は
      `https://ubiqy.jp/privacy/` / `https://ubiqy.jp/terms/` を指している
      (`PRIVACY_POLICY_URL` / `TERMS_URL`・[`../../docs/ci/store-setup.md`](../../docs/ci/store-setup.md) 0-2)。
      この2ページを残すなら**中身を一致させる**か、そちらへのリンクに置き換える。
      文面が食い違うと、申告と実物のずれとして審査で見られる
- [ ] **ストアの申告と文面を突き合わせる。** 改善のための利用を書いた以上、
      App Privacy(App Store Connect)とデータセーフティ(Google Play Console)の
      利用目的に「分析」を足す必要がある。いまの申告は「アプリの機能」だけなので、
      文面だけ直すと審査で食い違いを指摘される
- [ ] **Premium の「改善利用オフ」トグルを実装する。** 規約に書いた以上、
      アプリに無ければ嘘になる。プライバシーポリシー第4条・利用規約第5条
- [ ] 規約とポリシーの英語版。米国配信は Shipaton の参加要件なので、日本語だけでは足りない
- [ ] `SUPPORT_EMAIL` → フッタの問い合わせ先に追加(いまは GitHub Issues のみ)
- [ ] `public/404.html` → 足したら `wrangler.jsonc` の `not_found_handling` を `"404-page"` に
- [ ] **クローズドテストのトラックにリリースが載ったら、`public/beta/` と
      `public/en/beta/` のステップ2を押せるようにする。** 具体的には、`<li>` から
      `join-step-wait` を外して、`<span class="btn btn-soon">` を
      `<a class="btn btn-primary" href="https://play.google.com/apps/testing/jp.co.aiSensei">`
      に差し替え、後ろの `.tiny` から「いまはまだ開いても『テスターではありません』と出ます」を消す。
      リリースが1本も承認されていない間このURLは「テスターではありません」の画面に
      しかならないので、先に出さない([`docs/ci/store-setup.md`](../../docs/ci/store-setup.md) 2-4-1)。
      **日英2枚とも直すこと**
- [ ] 配信開始 → ヒーローと締めの CTA(いまはクローズドベータ)を実際のストアバッジとリンクに差し替え。
      iOS が先に出るので、**片方だけ出た状態**(App Storeのリンク + Google Playは「配信予定」)を
      一度は通ることになる。両方まとめて差し替えないこと。
      `styles.css` の `.btn-soon` は、そのときのために残してある
- [ ] OGP画像(`og:image`)。1200×630。`apps/mobile/tool/` と同じく**コードから生成する**こと
