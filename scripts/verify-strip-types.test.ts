import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STRIPPED_ROOTS, checkFile, checkRoots, listSourceFiles } from "./verify-strip-types.ts";

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "strip-types-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const PARAMETER_PROPERTY = "export class A { constructor(private readonly x: number) {} }\n";
const PLAIN =
  "export class B {\n  private readonly x: number;\n  constructor(x: number) { this.x = x; }\n}\n";

describe("型ストリップの検査", () => {
  it("parameter property を落とす(agentが起動時に死ぬ構文)", () => {
    const root = workspace({ "src/log.ts": PARAMETER_PROPERTY });
    const failure = checkFile(root, join(root, "src/log.ts"));

    expect(failure?.code).toBe("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(failure?.file).toBe("src/log.ts");
  });

  it("宣言と代入に分けてあれば通す", () => {
    const root = workspace({ "src/log.ts": PLAIN });

    expect(checkFile(root, join(root, "src/log.ts"))).toBeNull();
  });

  it("enum も落とす(値を生成するので型を消すだけでは動かない)", () => {
    const root = workspace({ "src/kind.ts": "export enum Kind { New, Review }\n" });

    expect(checkFile(root, join(root, "src/kind.ts"))?.code).toBe(
      "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
    );
  });

  it("型注釈だけのファイルは通す", () => {
    const root = workspace({
      "src/types.ts": "export type Session = { id: string };\nexport const one: number = 1;\n",
    });

    expect(checkFile(root, join(root, "src/types.ts"))).toBeNull();
  });

  it("テストとd.tsは見ない(vitestとtscしか読まないので実行時の制約がかからない)", () => {
    const root = workspace({
      "src/a.ts": PLAIN,
      "src/a.test.ts": PARAMETER_PROPERTY,
      "src/a.d.ts": "export declare const x: number;\n",
    });

    expect(listSourceFiles(join(root, "src"))).toEqual([join(root, "src/a.ts")]);
  });

  it("node_modules は見ない", () => {
    const root = workspace({
      "src/a.ts": PLAIN,
      "src/node_modules/dep/index.ts": PARAMETER_PROPERTY,
    });

    expect(checkRoots(root, ["src"])).toEqual([]);
  });

  it("無いディレクトリは失敗にしない", () => {
    const root = workspace({ "src/a.ts": PLAIN });

    expect(checkRoots(root, ["src", "packages"])).toEqual([]);
  });

  it("落ちたファイルをすべて挙げる(1つ直して再実行、を繰り返さずに済む)", () => {
    const root = workspace({
      "src/log.ts": PARAMETER_PROPERTY,
      "src/transcript.ts": PARAMETER_PROPERTY,
      "src/ok.ts": PLAIN,
    });

    expect(checkRoots(root, ["src"]).map((f) => f.file)).toEqual([
      "src/log.ts",
      "src/transcript.ts",
    ]);
  });

  it("リポジトリ本体が型ストリップで動く", () => {
    const repoRoot = resolve(import.meta.dirname, "..");

    expect(checkRoots(repoRoot, STRIPPED_ROOTS)).toEqual([]);
  });

  it("backend/api は対象外(wranglerがesbuildで変換するため)", () => {
    expect(STRIPPED_ROOTS).not.toContain("backend/api/src");
  });
});
