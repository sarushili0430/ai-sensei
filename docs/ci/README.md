# CI ワークフローのテンプレート

このディレクトリのYAMLは、そのまま `.github/workflows/` に配置して使うテンプレートです。

```bash
mkdir -p .github/workflows
cp docs/ci/ci.yml           .github/workflows/ci.yml
cp docs/ci/deploy.yml       .github/workflows/deploy.yml
cp docs/ci/deploy-agent.yml .github/workflows/deploy-agent.yml
cp docs/ci/golden.yml       .github/workflows/golden.yml
git add .github/workflows/ && git commit -m "ci: enable CI and deploy workflows"
```

コピー先が既にあるときは、**テンプレート側が正**なので上書きしてよい
(差分を確認するなら `diff docs/ci/ci.yml .github/workflows/ci.yml`)。

> **`.github/workflows/` を直接編集したら、テンプレートに書き戻すこと。**
> `.github/workflows/` を直接いじれるのはリポジトリオーナーだけなので、
> そこだけ進んでテンプレートが取り残されることがあります。実際に
> `ci.yml` の「変更されたディレクトリに応じてジョブを出し分ける」設定
> (コミット `c6d9f94`)がテンプレートに入っておらず、**上の `cp` を素直に流すと
> その設定が消える**状態になっていました(2026-08-10 に同期済み)。
> `diff` が空でないときは、**どちらが新しいかを先に確かめてから** `cp` してください。

> **なぜテンプレート置き場なのか**
> GitHub App(Claude Code等の自動化)は `workflows` 権限を持たないため、
> `.github/workflows/` 配下のファイルをpushできません(`refusing to allow a GitHub App
> to create or update workflow`)。リポジトリオーナーが手元で上記のコピーを1度だけ
> コミットすれば、以降の更新も同じ手順で反映できます。

## ワークフロー一覧

| ファイル | トリガ | 内容 |
| -------- | ------ | ---- |
| `ci.yml` | `develop`/`main` へのpush、全PR | `pnpm run lint`(Biome)/ `pnpm run typecheck` / `pnpm test` / 記事の生成物とスキルの同期 / Workerのdry-runビルド / Flutter(analyze + test)/ シークレット走査 |
| `deploy.yml` | `develop`/`main` へのpush(`backend/api` などに変更があったとき)、手動実行 | `backend/api` を Cloudflare Workers へデプロイ。`develop`→develop環境 / `main`→production環境 |
| `deploy-agent.yml` | `develop`/`main` へのpush(`backend/agent` などに変更があったとき)、手動実行 | `backend/agent` を LiveKit Cloud へデプロイ(ソースを送り、ビルドは向こうで走る) |
| `golden.yml` | **手動実行のみ** | golden test のPNGを Linux で焼き直し、artifact として出す(下記) |

`deploy.yml` には Cloudflare のAPIトークンが要ります。リソースの作成・secretの登録・
トークンの権限までの手順は [`docs/deploy.md`](../deploy.md) にまとめてあります。
**リソースIDを差し替えるまでデプロイは走りません**(`wrangler.toml` に
`REPLACE_ME` が残っていたらワークフローの最初のステップで落ちます)。

`deploy-agent.yml` には LiveKit のAPIキーと、`lk agent create` が返す agent のID
(Variables の `LIVEKIT_AGENT_ID`)が要ります。**初回の登録だけは手元で行います**
(手順は [`docs/deploy-agent.md`](../deploy-agent.md))。

Flutterのバージョンは `apps/mobile/.fvmrc` から読みます(手元のfvmとCIで同じ値を使う)。
golden test は **Linuxのラスタライズを正** とするので、生成もCIで行います。

lint・typecheck・test は `if: !cancelled()` で連ねてあるので、
lintが落ちても後続が走ります(1回のCIで直すべき箇所をまとめて見られるように)。

`apps/mobile` のビルドとTestFlight配布は Codemagic 側(リポジトリ直下の
`codemagic.yaml`)で行うため、GitHub Actions では扱いません。
Codemagic側でやる設定(YAMLへの切り替え・APIキー・keystore・変数グループ)は
[`codemagic.md`](./codemagic.md)、
ビルドを受け取る側(App Store Connect / Play Console)の設定は
[`store-setup.md`](./store-setup.md) にまとめてあります。

golden test の正となる実行はこちら(ubuntu-latest)です。Codemagicはmacなので、
`golden` タグを付けて `--exclude-tags golden` で外しています。

## golden を焼き直す(`golden.yml`)

`ci.yml` は golden を**照合するだけ**で、焼き直しはしません。
焼き直しは `golden.yml` を **Actions から手動で起動**します
(Actions → Update goldens → Run workflow → ブランチを選ぶ)。
成果物は artifact `goldens` に入るので、落として
`apps/mobile/test/golden/goldens/` に置き、**テストファイルと同じコミット**に入れます。
使い方の全体は [`apps/mobile/test/golden/README.md`](../../apps/mobile/test/golden/README.md)。

**自動起動にしていないのは意図的**です。pushのたびに焼き直すと、golden は
常に現状追認になり、**壊れを検知する能力を失います**。

Flutterのバージョンは `ci.yml` と**同じ `.fvmrc` から読みます**。
「同じ値を書く」ではなく「同じファイルから読む」形にしてあるのは、
`.fvmrc` を上げたときに片方だけ古いまま残ると、**焼いた瞬間から差分の出るPNG**が
できあがるためです。ランナーも `ubuntu-latest` で揃えています。
