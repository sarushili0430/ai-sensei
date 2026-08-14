/**
 * prompts/*.md -> src/generated.ts
 *
 *   pnpm --filter @ai-sensei/prompts generate
 *
 * Workers and the agent cannot assume a filesystem, so the Markdown is baked into
 * string constants. The output is committed, and drift fails the tests.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const promptsDir = resolve(import.meta.dirname, "..", "..", "..", "prompts");

export function promptFiles(): string[] {
  return readdirSync(promptsDir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
}

export function buildGeneratedSource(): string {
  const entries = promptFiles().map((file) => {
    const source = readFileSync(resolve(promptsDir, file), "utf8");
    return `  ${JSON.stringify(file)}: ${JSON.stringify(source)},`;
  });

  return [
    "// このファイルは自動生成です。編集しないでください。",
    "// 生成元: prompts/*.md",
    "// 再生成: pnpm --filter @ai-sensei/prompts generate",
    "",
    "export const promptSources: Record<string, string> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

if (process.argv[1]?.endsWith("generate.ts")) {
  const outFile = resolve(import.meta.dirname, "generated.ts");
  writeFileSync(outFile, buildGeneratedSource(), "utf8");
  console.log(`generated ${outFile} (${promptFiles().length} prompts)`);
}
