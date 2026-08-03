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
| `ci.yml` | `develop`/`main` へのpush、全PR | `npm run typecheck` / `npm test` / `npm run verify:secrets` |

`apps/mobile` のビルドとTestFlight配布は Codemagic 側(`codemagic.yaml`)で行うため、
GitHub Actions では扱いません。
