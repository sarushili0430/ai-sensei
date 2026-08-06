/**
 * agentが実行時に読む `.ts` が、**型を消すだけ**で動くかを確かめる。
 *
 * `backend/agent` はビルド手順を持たず、`node --experimental-strip-types` で
 * `.ts` を直接動かす([ADR 0002](../docs/adr/0002-agent-runtime.md))。
 * このモードは型注釈を空白に置き換えるだけなので、**値の生成を伴うTS構文**
 * (parameter property / enum / namespace)は通らない。
 *
 * ここを機械で見るのは、**テストが通るのに本番だけ落ちる**ため。vitestは
 * esbuildでTSをフル変換するので、`constructor(private readonly x: T)` を
 * 書いてもテストは緑のまま通り、ワーカーの起動時にだけ落ちる。
 * アプリからは「後輩が来ない」としか見えない、いちばん高くつく壊れ方になる。
 *
 * 見るのは agent と、agentが `workspace:*` で読む packages(いずれも
 * `exports` が `./src/index.ts` を指すので、実行時に同じ制約がかかる)。
 * `backend/api` は wrangler(esbuild)を通るので対象外。
 *
 *   pnpm run verify:strip-types
 */
import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative, resolve } from "node:path";

/** 実行時に型ストリップを通るディレクトリ。ここに `backend/api` は入れない。 */
export const STRIPPED_ROOTS = ["backend/agent/src", "packages"] as const;

export type StripFailure = {
  /** リポジトリルートからの相対パス。 */
  file: string;
  /** Nodeのエラーコード(例: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`)。 */
  code: string;
  message: string;
};

/** `.ts` を集める。テストはvitest(esbuild)しか読まないので対象外。 */
export function listSourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      // 未取得のワークスペースなどは黙って飛ばす(存在しないことは失敗ではない)
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      found.push(path);
    }
  };

  walk(root);
  return found.sort();
}

/** 1ファイルを型ストリップにかける。通れば null、落ちれば理由を返す。 */
export function checkFile(repoRoot: string, path: string): StripFailure | null {
  const source = readFileSync(path, "utf8");
  try {
    stripTypeScriptTypes(source, { mode: "strip" });
    return null;
  } catch (error) {
    const { code, message } = describe(error);
    return { file: relative(repoRoot, path), code, message };
  }
}

export function checkRoots(repoRoot: string, roots: readonly string[]): StripFailure[] {
  const failures: StripFailure[] = [];
  for (const root of roots) {
    for (const path of listSourceFiles(resolve(repoRoot, root))) {
      const failure = checkFile(repoRoot, path);
      if (failure !== null) failures.push(failure);
    }
  }
  return failures;
}

function describe(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const raw = (error as { code?: unknown }).code;
    // Nodeは該当行を続けて出すので、1行目(理由)だけを見せる
    return {
      code: typeof raw === "string" ? raw : error.name,
      message: error.message.split("\n")[0] ?? error.message,
    };
  }
  return { code: "Unknown", message: String(error) };
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, "..");
  const failures = checkRoots(repoRoot, STRIPPED_ROOTS);

  if (failures.length === 0) {
    console.log(`✔ 型ストリップで動く (${STRIPPED_ROOTS.join(", ")})`);
    return;
  }

  console.error("✘ 型を消すだけでは動かない構文があります(agentが起動時に落ちます):");
  for (const failure of failures) {
    console.error(`  ${failure.file}  [${failure.code}]  ${failure.message}`);
  }
  console.error(
    "\nparameter property は `private readonly x: T;` の宣言と" +
      "コンストラクタ内の代入に分けてください。" +
      "enum は `as const` のオブジェクトに、namespace は通常のexportに置き換えます。",
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(resolve(process.argv[1]), resolve(import.meta.dirname, "verify-strip-types.ts")) === "";

if (invokedDirectly) main();
