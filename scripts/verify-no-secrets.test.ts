import { describe, expect, it } from "vitest";
import { redact, scanContent } from "./verify-no-secrets.ts";

// 検出パターンはテスト内で組み立てる(このファイル自体が走査対象から
// 外れていても、リテラルで書くと将来のgrepベース監査を汚すため)。
const fake = (prefix: string, body: string) => `${prefix}${body}`;

describe("scanContent", () => {
  it("プレースホルダだけの.env.exampleは検出しない", () => {
    const content = ["ANTHROPIC_API_KEY=", "LIVEKIT_URL=wss://example.livekit.cloud", ""].join(
      "\n",
    );
    expect(scanContent(".env.example", content)).toEqual([]);
  });

  it("Anthropicの鍵を検出する", () => {
    const content = `ANTHROPIC_API_KEY=${fake("sk-ant-", "A".repeat(40))}`;
    const leaks = scanContent(".dev.vars", content);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.rule).toBe("anthropic-api-key");
    expect(leaks[0]?.line).toBe(1);
  });

  it("行番号を1始まりで返す", () => {
    const content = ["# comment", "", `key = "${fake("AIza", "B".repeat(35))}"`].join("\n");
    expect(scanContent("worker.ts", content)[0]?.line).toBe(3);
  });

  it("秘密鍵ブロックを検出する", () => {
    const leaks = scanContent("key.pem", "-----BEGIN RSA PRIVATE KEY-----");
    expect(leaks.map((l) => l.rule)).toContain("private-key-block");
  });

  it("暗号化された秘密鍵ブロック(PKCS#8)も検出する", () => {
    const leaks = scanContent("key.key", "-----BEGIN ENCRYPTED PRIVATE KEY-----");
    expect(leaks.map((l) => l.rule)).toContain("private-key-block");
  });

  // 実際の .dev.vars は `LIVEKIT_API_KEY=API...` の形。手がかりの語が値の前に来る
  it("LiveKitの鍵を、変数名が値の前にある形でも検出する", () => {
    const content = `LIVEKIT_API_KEY=${fake("API", "k".repeat(16))}`;
    expect(scanContent(".dev.vars", content).map((l) => l.rule)).toContain("livekit-api-key");
  });

  it("LiveKitの鍵を、手がかりの語が値の後ろにある形でも検出する", () => {
    const content = `const key = "${fake("API", "k".repeat(16))}" // livekit`;
    expect(scanContent("worker.ts", content).map((l) => l.rule)).toContain("livekit-api-key");
  });

  it("allowlistプラグマの行は無視する", () => {
    const content = `token = "${fake("ghp_", "C".repeat(36))}" // pragma: allowlist secret`;
    expect(scanContent("fixture.ts", content)).toEqual([]);
  });

  it("検出値はマスクして返す", () => {
    const secret = fake("sk-ant-", "D".repeat(40));
    const leaks = scanContent(".dev.vars", `KEY=${secret}`);
    expect(leaks[0]?.excerpt).not.toContain(secret);
    expect(leaks[0]?.excerpt).toContain("*");
  });
});

describe("redact", () => {
  it("短い値は全マスク", () => {
    expect(redact("abcd")).toBe("****");
  });

  it("長い値は先頭と末尾4文字だけ残す", () => {
    const out = redact("abcdefghijklmnop");
    expect(out.startsWith("abcd")).toBe(true);
    expect(out.endsWith("mnop")).toBe(true);
  });
});
