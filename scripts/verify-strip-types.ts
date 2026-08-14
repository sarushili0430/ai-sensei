/**
 * Verifies the `.ts` the agent reads at runtime works with types merely stripped.
 *
 * `backend/agent` has no build step and runs `.ts` directly with
 * `node --experimental-strip-types` ([ADR 0002](../docs/adr.md#adr-0002)).
 * That mode only replaces type annotations with whitespace, so TS syntax that also
 * emits values (parameter properties, enum, namespace) does not work.
 *
 * This is checked mechanically because otherwise the tests pass and only production
 * fails. vitest fully transpiles TS with esbuild, so
 * `constructor(private readonly x: T)` stays green in tests and fails only when the
 * worker starts - which the app shows merely as "the agent never came", the most
 * expensive kind of breakage.
 *
 * It checks the agent and the packages the agent reads via `workspace:*` (whose
 * `exports` point at `./src/index.ts`, so the same constraint applies at runtime).
 * `backend/api` goes through wrangler (esbuild) and is out of scope.
 *
 *   pnpm run verify:strip-types
 */
import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative, resolve } from "node:path";

/** Directories that go through type stripping at runtime. `backend/api` never belongs here. */
export const STRIPPED_ROOTS = ["backend/agent/src", "packages"] as const;

export type StripFailure = {
  /** Path relative to the repo root. */
  file: string;
  /** Node's error code (e.g. `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). */
  code: string;
  message: string;
};

/** Collects `.ts` files. Tests are out of scope, since only vitest (esbuild) reads them. */
export function listSourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      // Silently skip unfetched workspaces (absence is not a failure)
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

/** Runs one file through type stripping. Returns null on success, the reason on failure. */
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
    // Node prints the offending line after it, so show only the first line (the reason)
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
