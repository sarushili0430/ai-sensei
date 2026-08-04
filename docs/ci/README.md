# CI ワークフローのテンプレート

このディレクトリのYAMLは、そのまま `.github/workflows/` に配置して使うテンプレートです。

```bash
mkdir -p .github/workflows
cp docs/ci/ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml && git commit -m "ci: enable CI workflow"
```

> **なぜテンプレート置き場なのか**
> GitHub App(Claude Code等の自動化)は `workflows` 権限を持たないため、
> `.github/workflows/` 配下のファイルをpushできません(`refusing to allow a GitHub App
> to create or update workflow`)。リポジトリオーナーが手元で上記のコピーを1度だけ
> コミットすれば、以降の更新も同じ手順で反映できます。

## ワークフロー一覧

| ファイル | トリガ | 内容 |
| -------- | ------ | ---- |
| `ci.yml` | `develop`/`main` へのpush、全PR | `pnpm run lint`(Biome)/ `pnpm run typecheck` / `pnpm test` / Flutter(analyze + test)/ シークレット走査 |

Flutterのバージョンは `apps/mobile/.fvmrc` から読みます(手元のfvmとCIで同じ値を使う)。
golden test は **Linuxのラスタライズを正** とするので、生成もCIで行います。

lint・typecheck・test は `if: !cancelled()` で連ねてあるので、
lintが落ちても後続が走ります(1回のCIで直すべき箇所をまとめて見られるように)。

`apps/mobile` のビルドとTestFlight配布は Codemagic 側(リポジトリ直下の
`codemagic.yaml`)で行うため、GitHub Actions では扱いません。
Codemagic側でやる設定(YAMLへの切り替え・APIキー・keystore・変数グループ)は
[`codemagic.md`](./codemagic.md) にまとめてあります。

golden test の正となる実行はこちら(ubuntu-latest)です。Codemagicはmacなので、
`golden` タグを付けて `--exclude-tags golden` で外しています。
