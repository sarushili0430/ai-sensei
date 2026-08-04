/**
 * wrangler.toml のバインディングが埋まっているかを**環境ごとに**確かめる。
 *
 * D1/KVのIDはリポジトリにプレースホルダ(`REPLACE_ME`)で入っていて、
 * 各自が `wrangler d1 create` などの出力で差し替える。埋め忘れたまま deploy すると
 * Cloudflareからは「そんなリソースは無い」という分かりにくいエラーが返るので、
 * その手前で落とすためのチェック。
 *
 * **ファイル全体をgrepしないのが要点。** develop だけ先に立ち上げて production は
 * あとで作る、という順番はふつうにあるので、production が未設定なことを理由に
 * develop のデプロイを止めてはいけない。
 *
 *   pnpm run verify:bindings develop
 *   pnpm run verify:bindings production
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const PLACEHOLDER = "REPLACE_ME";

export type Placeholder = {
  /** 属していたTOMLのセクション名(例: `env.develop.d1_databases`)。 */
  section: string;
  line: number;
  /** `=` の左側。どのキーを埋めればいいかを出すために持つ。 */
  key: string;
};

/** `[foo.bar]` / `[[foo.bar]]` の見出しからセクション名を取り出す。見出しでなければ null。 */
function parseSectionHeader(line: string): string | null {
  const match = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
  return match?.[1]?.trim() ?? null;
}

/** そのセクションが環境 `env` のものか。`[env.develop]` 自身とその配下を含む。 */
function belongsTo(section: string, env: string): boolean {
  return section === `env.${env}` || section.startsWith(`env.${env}.`);
}

/** wrangler.toml に定義されている環境名(`[env.x]` の x)を列挙する。 */
export function listEnvironments(toml: string): string[] {
  const found = new Set<string>();
  for (const line of toml.split("\n")) {
    const section = parseSectionHeader(line);
    // `env.develop.d1_databases` のような入れ子からも `develop` を拾う
    const match = section && /^env\.([^.]+)/.exec(section);
    if (match?.[1]) found.add(match[1]);
  }
  return [...found];
}

/**
 * 指定した環境のセクションに残っているプレースホルダを返す。
 * トップレベル(`wrangler dev` 専用)や他の環境の行は見ない。
 */
export function findPlaceholders(toml: string, env: string): Placeholder[] {
  const placeholders: Placeholder[] = [];
  let section = "";

  toml.split("\n").forEach((line, index) => {
    const header = parseSectionHeader(line);
    if (header !== null) {
      section = header;
      return;
    }
    if (!belongsTo(section, env)) return;
    if (!line.includes(PLACEHOLDER)) return;

    placeholders.push({
      section,
      line: index + 1,
      key: line.split("=")[0]?.trim() ?? line.trim(),
    });
  });

  return placeholders;
}

function main(): void {
  const env = process.argv[2];
  const repoRoot = resolve(import.meta.dirname, "..");
  const path = process.argv[3] ?? "backend/api/wrangler.toml";

  if (!env) {
    console.error("環境名が要ります: pnpm run verify:bindings <develop|production>");
    process.exitCode = 1;
    return;
  }

  const toml = readFileSync(resolve(repoRoot, path), "utf8");
  const environments = listEnvironments(toml);

  // 環境名のtypoを「プレースホルダ0件」として素通ししないため、先に存在を確かめる
  if (!environments.includes(env)) {
    console.error(`✘ ${path} に [env.${env}] がありません(あるのは: ${environments.join(", ")})`);
    process.exitCode = 1;
    return;
  }

  const placeholders = findPlaceholders(toml, env);
  if (placeholders.length === 0) {
    console.log(`✔ [env.${env}] のバインディングは設定済み`);
    return;
  }

  console.error(`✘ [env.${env}] のIDが未設定です:`);
  for (const item of placeholders) {
    console.error(`  ${path}:${item.line}  ${item.section}.${item.key} = "${PLACEHOLDER}"`);
  }
  console.error("\ndocs/deploy.md の手順でリソースを作り、出力されたIDで差し替えてください。");
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(
    resolve(process.argv[1]),
    resolve(import.meta.dirname, "verify-wrangler-bindings.ts"),
  ) === "";

if (invokedDirectly) main();
