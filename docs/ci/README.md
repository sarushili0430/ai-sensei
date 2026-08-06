# CI ワークフローのテンプレート

このディレクトリのYAMLは、そのまま `.github/workflows/` に配置して使うテンプレートです。

```bash
mkdir -p .github/workflows
cp docs/ci/ci.yml           .github/workflows/ci.yml
cp docs/ci/deploy.yml       .github/workflows/deploy.yml
cp docs/ci/deploy-agent.yml .github/workflows/deploy-agent.yml
git add .github/workflows/ && git commit -m "ci: enable CI and deploy workflows"
```

コピー先が既にあるときは、**テンプレート側が正**なので上書きしてよい
(差分を確認するなら `diff docs/ci/ci.yml .github/workflows/ci.yml`)。

> **なぜテンプレート置き場なのか**
> GitHub App(Claude Code等の自動化)は `workflows` 権限を持たないため、
> `.github/workflows/` 配下のファイルをpushできません(`refusing to allow a GitHub App
> to create or update workflow`)。リポジトリオーナーが手元で上記のコピーを1度だけ
> コミットすれば、以降の更新も同じ手順で反映できます。

## ワークフロー一覧

| ファイル | トリガ | 内容 |
| -------- | ------ | ---- |
| `ci.yml` | `develop`/`main` へのpush、全PR | `pnpm run lint`(Biome)/ `pnpm run typecheck` / `pnpm test` / Workerのdry-runビルド / Flutter(analyze + test)/ シークレット走査 |
| `deploy.yml` | `develop`/`main` へのpush(`backend/api` などに変更があったとき)、手動実行 | `backend/api` を Cloudflare Workers へデプロイ。`develop`→develop環境 / `main`→production環境 |
| `deploy-agent.yml` | `develop`/`main` へのpush(`backend/agent` などに変更があったとき)、手動実行 | `backend/agent` を LiveKit Cloud へデプロイ(ソースを送り、ビルドは向こうで走る) |

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
