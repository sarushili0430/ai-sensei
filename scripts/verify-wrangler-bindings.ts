/**
 * Verifies, per environment, that wrangler.toml's bindings are filled in.
 *
 * D1 and KV ids live in the repo as placeholders (`REPLACE_ME`) and each person
 * substitutes the output of `wrangler d1 create` and friends. Deploying with one
 * unfilled returns an opaque "no such resource" from Cloudflare, so this fails
 * before that.
 *
 * The point is that it does not grep the whole file. Bringing up develop first and
 * creating production later is a normal order, so production being unconfigured
 * must never block a develop deploy.
 *
 *   pnpm run verify:bindings develop
 *   pnpm run verify:bindings production
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const PLACEHOLDER = "REPLACE_ME";

export type Placeholder = {
  /** The TOML section it belonged to (e.g. `env.develop.d1_databases`). */
  section: string;
  line: number;
  /** The left side of the `=`. Kept so we can report which key to fill in. */
  key: string;
};

/** Extracts a section name from a `[foo.bar]` / `[[foo.bar]]` heading. null if it is not one. */
function parseSectionHeader(line: string): string | null {
  const match = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
  return match?.[1]?.trim() ?? null;
}

/** Whether that section belongs to environment `env`. Includes `[env.develop]` itself and everything under it. */
function belongsTo(section: string, env: string): boolean {
  return section === `env.${env}` || section.startsWith(`env.${env}.`);
}

/** Lists the environment names defined in wrangler.toml (the x in `[env.x]`). */
export function listEnvironments(toml: string): string[] {
  const found = new Set<string>();
  for (const line of toml.split("\n")) {
    const section = parseSectionHeader(line);
    // Also picks `develop` out of nesting such as `env.develop.d1_databases`
    const match = section && /^env\.([^.]+)/.exec(section);
    if (match?.[1]) found.add(match[1]);
  }
  return [...found];
}

/**
 * Returns the placeholders left in that environment's sections.
 * Top-level lines (for `wrangler dev` only) and other environments are ignored.
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

  // Check existence first, so a typo'd environment name does not pass as "zero placeholders"
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
