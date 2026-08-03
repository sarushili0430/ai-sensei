# ADR 0001: モノレポ構成と npm workspaces の採用

- ステータス: 承認
- 日付: 2026-08-03
- 関連: `docs/handoff_to_opus.md` §5

## 背景

Shipaton 2026 の Next Gen Award は **リポジトリ単体でプロジェクトが動くこと** を要件にしており、
提出単位がリポジトリそのものになる。加えて、ソロ開発で8週間という制約があるため、
アプリ・バックエンド・エージェント・共有データを別リポジトリに分けると、
契約変更のたびに複数リポジトリを行き来するコストが重い。

当初は全Dart案(Flutter + Dart Frog)で型を共有する計画だったが、

- インフラをCloudflare Workersに寄せた(Dartランタイムがない)
- リアルタイム会話をLiveKit Agentsに乗せた(Node/Pythonが前提)

の2点で撤回した。

## 決定

1. **単一リポジトリ**に `apps/mobile`・`workers/api`・`agent`・`packages/*` を同居させる。
2. TypeScript側(`workers/*`・`agent`・`packages/*`)は **npm workspaces** で束ねる。
   pnpm/yarnではなくnpmにするのは、Node同梱でCI・Codemagic・新規参加者の環境差が最小になるため。
3. パッケージスコープは **`@ai-sensei/*`** とする。プロダクト名(カタルテ / セツメイト /
   ときがたり)は未確定であり、確定前に名前をimport文へ焼き付けると全ファイルの改名が必要になる。
   リポジトリ名は変わらないので、スコープはリポジトリ名に合わせる。
4. 言語をまたぐ型共有は行わず、**`packages/contract` のスキーマとfixtureを正**とする。
   Flutter(freezed)とTypeScript(zod)の双方が同じfixtureをパースするテストをCIで回し、
   契約ドリフトを検知する。
5. カリキュラムマップは **純JSON**(`packages/curriculum`)に置く。
   Workers・agent・モバイルのいずれからも言語中立に読めることを優先する。

## 結果

- 良い点: 1PRでAPI・エージェント・アプリの整合を取れる。提出物がリポジトリ1つで完結する。
- 良い点: `.env.example` 方式と `npm run verify:secrets` をリポジトリ全体に一度だけ用意すればよい。
- 悪い点: CIが素朴に組むと全体が毎回走る。GitHub Actions側でpathフィルタを効かせて分担する
  (`apps/mobile` → Codemagic、`workers/**` → wrangler deploy、`agent/**` → LiveKitへ)。
- 悪い点: TypeScriptとDartでスキーマ定義が二重になる。fixture検証テストで担保する。
