import { llm } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { CachedInstructionsLLM } from "./conversation-llm.ts";

/** protected な変換をテストから覗くためだけの薄い口。挙動は足さない。 */
class ProbeLLM extends CachedInstructionsLLM {
  build(chatCtx: llm.ChatContext) {
    return this._buildAnthropicContext(chatCtx);
  }
}

function probe(): ProbeLLM {
  return new ProbeLLM({ apiKey: "test-key", model: "claude-haiku-4-5-20251001" });
}

function contextWith(items: readonly { role: "system" | "user" | "assistant"; text: string }[]) {
  const chatCtx = llm.ChatContext.empty();
  for (const item of items) chatCtx.addMessage({ role: item.role, content: item.text });
  return chatCtx;
}

describe("CachedInstructionsLLM", () => {
  it("指示文にキャッシュの印を付ける", () => {
    const built = probe().build(
      contextWith([
        { role: "system", text: "あなたは先輩です。" },
        { role: "user", text: "ここまでいい?" },
      ]),
    );

    expect(built.system).toHaveLength(1);
    expect(built.system[0]).toMatchObject({
      type: "text",
      text: "あなたは先輩です。",
      cache_control: { type: "ephemeral" },
    });
  });

  // キャッシュは「印まで」のプレフィックスとして載る。複数ブロックのとき手前にも
  // 付けるとブレークポイント(上限4つ)を無駄に食うので、最後の1つだけにする。
  it("system が複数あっても印は最後の1つだけ", () => {
    const built = probe().build(
      contextWith([
        { role: "system", text: "先輩の人物像。" },
        { role: "system", text: "板書の要約。" },
        { role: "user", text: "うん" },
      ]),
    );

    expect(built.system).toHaveLength(2);
    expect(built.system[0]).not.toHaveProperty("cache_control");
    expect(built.system[1]).toHaveProperty("cache_control", { type: "ephemeral" });
  });

  // 会話履歴は毎ターン伸びるので、印を付けても書き込みばかりでヒットしない。
  // プラグインが足すダミーの user ターンごと、messages 側は素通しであることを縛る。
  it("会話履歴には印を付けない", () => {
    const built = probe().build(
      contextWith([
        { role: "system", text: "あなたは先輩です。" },
        { role: "user", text: "2行目から3行目、何をした?" },
        { role: "assistant", text: "両辺を2で割った。" },
      ]),
    );

    for (const message of built.messages) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) expect(block).not.toHaveProperty("cache_control");
    }
  });

  // 授業の前は指示文がまだ無い経路がある。印の付け先が無いときに落ちない。
  it("system が空でも落ちない", () => {
    const built = probe().build(contextWith([{ role: "user", text: "こんにちは" }]));
    expect(built.system).toEqual([]);
  });
});
