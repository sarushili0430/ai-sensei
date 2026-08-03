/**
 * prompts/*.md → src/generated.ts
 *
 *   npm run -w @ai-sensei/prompts generate
 *
 * Workers/agentはファイルシステムを前提にできないので、Markdownを文字列定数に
 * 焼き込む。生成物はコミットし、ずれていればテストが落ちる。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    "// 再生成: npm run -w @ai-sensei/prompts generate",
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
