import { describe, expect, it } from "vitest";
import { findPlaceholders, listEnvironments } from "./verify-wrangler-bindings.ts";

// 実物の wrangler.toml と同じ形(トップレベル + 2環境)。
const toml = [
  'name = "ai-sensei-api"',
  "",
  "[[d1_databases]]",
  'binding = "DB"',
  'database_id = "local"',
  "",
  "[env.develop]",
  'name = "ai-sensei-api-develop"',
  "",
  "[[env.develop.d1_databases]]",
  'binding = "DB"',
  'database_id = "905cb605-787f-419a-ae94-d27cef8c6f55"',
  "",
  "[[env.develop.kv_namespaces]]",
  'binding = "METER"',
  'id = "6512564002614694a9b1bca5616c7442"',
  "",
  "[env.production]",
  'name = "ai-sensei-api-production"',
  "",
  "[[env.production.d1_databases]]",
  'binding = "DB"',
  'database_id = "REPLACE_ME"     # 差し替える',
  "",
  "[[env.production.kv_namespaces]]",
  'binding = "METER"',
  'id = "REPLACE_ME"',
].join("\n");

describe("findPlaceholders", () => {
  // これが壊れると「developだけ先に立ち上げる」ができなくなる。
  // productionが未設定なことを理由にdevelopのデプロイを止めてはいけない。
  it("埋まっている環境では何も返さない", () => {
    expect(findPlaceholders(toml, "develop")).toEqual([]);
  });

  it("未設定の環境のプレースホルダだけを返す", () => {
    const found = findPlaceholders(toml, "production");
    expect(found.map((p) => p.key)).toEqual(["database_id", "id"]);
    expect(found.map((p) => p.section)).toEqual([
      "env.production.d1_databases",
      "env.production.kv_namespaces",
    ]);
  });

  it("行番号を1始まりで返す", () => {
    expect(findPlaceholders(toml, "production")[0]?.line).toBe(23);
  });

  it("トップレベル(wrangler dev 専用)の行は環境に数えない", () => {
    const localOnly = ["[[d1_databases]]", 'database_id = "REPLACE_ME"'].join("\n");
    expect(findPlaceholders(localOnly, "develop")).toEqual([]);
  });

  // `[env.develop]` の見出し直下(配列テーブルの外)に書かれた場合も拾う
  it("環境の直下に書かれたプレースホルダも拾う", () => {
    const inline = ["[env.develop]", 'account_id = "REPLACE_ME"'].join("\n");
    expect(findPlaceholders(inline, "develop").map((p) => p.key)).toEqual(["account_id"]);
  });

  it("名前が前方一致する別環境と取り違えない", () => {
    const similar = [
      "[[env.develop.kv_namespaces]]",
      'id = "REPLACE_ME"',
      "[[env.develop2.kv_namespaces]]",
      'id = "filled"',
    ].join("\n");
    expect(findPlaceholders(similar, "develop2")).toEqual([]);
    expect(findPlaceholders(similar, "develop")).toHaveLength(1);
  });
});

describe("listEnvironments", () => {
  it("入れ子のセクションからも環境名を拾う", () => {
    expect(listEnvironments(toml).sort()).toEqual(["develop", "production"]);
  });

  it("環境が無ければ空", () => {
    expect(listEnvironments('name = "x"')).toEqual([]);
  });
});
