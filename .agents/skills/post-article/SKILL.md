---
name: post-article
description: カタルテ(ai-sensei)のLPに記事を投稿・更新・取り下げする。「記事を書いて」「ブログを書いて」「記事を投稿して」「お知らせを出して」「この記事を直して」「記事を下げて」と頼まれたときに使う。LP本体(トップ・規約・サポート)を直すときには使わない。
---

# 記事を投稿する

**記事の正は `apps/lp/articles/<slug>.md`。配信されるのは、そこから焼いた
`apps/lp/public/articles/` のHTML。生成物を直接書かないこと** —— 次の生成で必ず消える。

## 手順

1. **決まりを読む。** [`apps/lp/articles/README.md`](../../../apps/lp/articles/README.md)
   に、front matter・書ける記法・中身の決まりが全部ある。
   **既にある記事を1本読むこと。** 長さと文体はそれが正。
2. **`apps/lp/articles/<slug>.md` を書く。**
   ファイル名は英小文字・数字・ハイフンだけ(そのままURLになる)。`date` は今日の日付。
   書きかけで置くなら `draft: true`。
3. **焼く。** `pnpm run articles:build`
4. **確かめる。**
   `pnpm run verify:articles` と `pnpm --filter @ai-sensei/lp build:check`。
   見た目まで見るなら `pnpm --filter @ai-sensei/lp dev` → `http://localhost:8787/articles/`。
5. **`.md` と生成物を同じコミットに入れる。** 片方だけだとCIが落ちる。

**公開(`pnpm --filter @ai-sensei/lp deploy:production`)は、頼まれたときだけ実行する。**
コミットしただけでは公開されない。

## 書くときに守ること

- **事実だけ書く。** 作っていない機能、出していない対応教科・対応OSを書かない。
  迷ったら [`README.md`](../../../README.md) と `apps/lp/public/index.html` の記述より広げない
- **煽らない。点数や順位の話をしない。価格を書かない**(金額は RevenueCat の Offering から引くので、
  ページに焼くとストアの決済画面と食い違う)
- **無いものへのリンクを置かない。** 未公開のURLは、決まってから書く
- 生成が読めない記法は、行番号を添えて落ちる。**記事側で工夫せず、指された行を直す**

## 直す / 取り下げる

- 直す: `.md` を直して front matter に `updated: YYYY-MM-DD` を足し、`pnpm run articles:build`
- 取り下げる: `.md` を消すか `draft: true` にして `pnpm run articles:build`。
  生成物(`apps/lp/public/articles/<slug>/`)も一緒に片付く

## このファイルは2箇所にある

Codex は `.agents/skills/`、Claude Code は `.claude/skills/` を読む。
**中身は1文字まで同じで、`pnpm run verify:skills` が一致を見ている。**
片方だけ直すとCIが落ちるので、直したらもう片方にコピーすること。
