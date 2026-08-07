import {
  type CompleteSessionRequest,
  completeSessionRequestSchema,
  karteDraftSchema,
} from "@ai-sensei/contract";
import { describe, expect, it, vi } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  type LlmClient,
  applyGuardrails,
  buildKarte,
  emptyKarte,
  extractJson,
  postComplete,
  withUncertaintyHole,
} from "./karte.ts";

const context = readSessionContext(
  JSON.stringify({
    session_id: "ses_1",
    max_seconds: 300,
    photo_summary: "円と直線の位置関係",
    allowed_topics: "- M2-ZUKEI-ENCHOKU",
    allowed_topic_ids: ["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"],
    is_premium: false,
  }),
);

const premiumContext = readSessionContext(
  JSON.stringify({
    session_id: "ses_2",
    max_seconds: 900,
    allowed_topic_ids: ["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"],
    is_premium: true,
  }),
);

const validKarte = {
  said_well: ["中心と直線の距離で判定する方針を説明できた"],
  holes: [
    {
      topic_id: "M1-NIJI-HANBETSU",
      desc: "判別式を「なぜ」使うのか、で説明が止まった",
      severity: "medium",
      evidence: "なんとなくです",
    },
  ],
  term_notes: ["「解の公式」と「判別式」が混ざっていた"],
  followup_question: "判別式が0のときはどうなるんでしたっけ?",
};

function stubLlm(output: string): LlmClient {
  return { complete: async () => output };
}

describe("buildKarte", () => {
  it("LLMの出力からカルテを作る", async () => {
    const karte = await buildKarte({
      context,
      transcript: [{ role: "user", text: "距離で比べました", at_ms: 1000 }],
      llm: stubLlm(JSON.stringify(validKarte)),
    });

    expect(karte.said_well).toHaveLength(1);
    expect(karte.holes[0]?.topic_id).toBe("M1-NIJI-HANBETSU");
  });

  it("コードフェンス付きの出力でも読める", async () => {
    const karte = await buildKarte({
      context,
      transcript: [],
      llm: stubLlm(`\`\`\`json\n${JSON.stringify(validKarte)}\n\`\`\``),
    });
    expect(karte.holes).toHaveLength(1);
  });

  it("プロンプトに写真の要約とtranscriptを渡す", async () => {
    let captured = "";
    await buildKarte({
      context,
      transcript: [{ role: "user", text: "距離で比べました", at_ms: 1000 }],
      llm: {
        async complete({ system }) {
          captured = system;
          return JSON.stringify(validKarte);
        },
      },
    });

    const system = captured;
    expect(system).toContain("円と直線の位置関係");
    expect(system).toContain("ユーザー: 距離で比べました");
    expect(system).not.toContain("{{");
  });

  it("スキーマに合わない出力はエラーにする(呼び出し側で空カルテに倒す)", async () => {
    await expect(
      buildKarte({ context, transcript: [], llm: stubLlm('{"said_well": "文字列"}') }),
    ).rejects.toThrow();
  });
});

describe("applyGuardrails", () => {
  // 落ちるのはLLMが付けたIDであって、本人が説明に詰まった事実ではない。
  // 穴ごと捨てるとカルテが空になり、画面には「止まらずに説明できました」と出る。
  it("許可リスト外のtopic_idは、穴を捨てずに主単元へ付け替える", () => {
    const guarded = applyGuardrails(
      {
        ...karteDraftSchema.parse(validKarte),
        holes: [
          { topic_id: "M1-NIJI-HANBETSU", desc: "判別式で止まった", severity: "medium" },
          { topic_id: "MB-SURETSU-SIGMA", desc: "Σで止まった", severity: "low" },
        ],
      },
      context,
    );
    expect(guarded.holes.map((hole) => hole.desc)).toEqual(["判別式で止まった", "Σで止まった"]);
    expect(guarded.holes.map((hole) => hole.topic_id)).toEqual([
      "M1-NIJI-HANBETSU",
      "M2-ZUKEI-ENCHOKU",
    ]);
  });

  it("カリキュラムに無いIDを作られても、穴は残す", () => {
    const guarded = applyGuardrails(
      {
        ...karteDraftSchema.parse(validKarte),
        holes: [{ topic_id: "M9-NAI-TOPIC", desc: "理由で止まった", severity: "high" }],
      },
      context,
    );
    expect(guarded.holes).toEqual([
      { topic_id: "M2-ZUKEI-ENCHOKU", desc: "理由で止まった", severity: "high" },
    ]);
  });

  it("無料ユーザーにはあと追い質問を作らない", () => {
    expect(
      applyGuardrails(karteDraftSchema.parse(validKarte), context).followup_question,
    ).toBeNull();
  });

  it("Premiumにはあと追い質問を残す", () => {
    expect(
      applyGuardrails(karteDraftSchema.parse(validKarte), premiumContext).followup_question,
    ).toContain("判別式");
  });
});

// 「わからない」と何度も言ったのに「穴なし」と返すのが、このアプリで一番わるい間違い。
describe("withUncertaintyHole", () => {
  const said = (text: string) => ({ role: "user" as const, text, at_ms: 1000 });

  it("LLMが穴を1件も書かなくても、本人の申告から穴を1件残す", () => {
    const karte = withUncertaintyHole(emptyKarte(), context, [
      said("えっと、そこはわからないです"),
      { role: "assistant", text: "なるほど", at_ms: 2000 },
    ]);

    expect(karte.holes).toHaveLength(1);
    expect(karte.holes[0]?.topic_id).toBe("M2-ZUKEI-ENCHOKU");
    // 単元の名前が入る(「説明が止まった」の文体は崩さない)
    expect(karte.holes[0]?.desc).toContain("止まった");
    // 根拠は本人の言葉のまま。要約すると「そんなことは言っていない」になる。
    expect(karte.holes[0]?.evidence).toBe("えっと、そこはわからないです");
    expect(karteDraftSchema.safeParse(karte).success).toBe(true);
  });

  it("何度も言われているほど、次に効くものとして扱う", () => {
    const once = withUncertaintyHole(emptyKarte(), context, [said("わからないです")]);
    const twice = withUncertaintyHole(emptyKarte(), context, [
      said("わからないです"),
      said("そこも習ってないです"),
    ]);

    expect(once.holes[0]?.severity).toBe("medium");
    expect(twice.holes[0]?.severity).toBe("high");
    expect(twice.holes[0]?.evidence).toBe("わからないです / そこも習ってないです");
  });

  it("LLMが穴を書けているときは足さない(数を水増ししない)", () => {
    const drafted = applyGuardrails(karteDraftSchema.parse(validKarte), context);
    expect(withUncertaintyHole(drafted, context, [said("わからないです")])).toEqual(drafted);
  });

  it("わからないと言っていない会話には足さない", () => {
    const karte = emptyKarte();
    expect(withUncertaintyHole(karte, context, [said("距離で比べました")])).toEqual(karte);
    expect(withUncertaintyHole(karte, context, [])).toEqual(karte);
  });
});

describe("emptyKarte", () => {
  it("空のカルテも契約を満たす(会話が成立しなかった日)", () => {
    const body: CompleteSessionRequest = {
      transcript: [],
      karte: emptyKarte(),
      duration_seconds: 12,
      ended_reason: "user_left",
    };
    expect(completeSessionRequestSchema.safeParse(body).success).toBe(true);
  });
});

describe("extractJson", () => {
  it("前置きが付いていても拾う", () => {
    expect(extractJson('できました。\n{"a":1}')).toEqual({ a: 1 });
  });

  it("JSONがなければエラー", () => {
    expect(() => extractJson("うまく作れませんでした")).toThrow();
  });
});

describe("postComplete", () => {
  const body: CompleteSessionRequest = {
    transcript: [],
    karte: emptyKarte(),
    duration_seconds: 100,
    ended_reason: "completed",
  };

  it("内部トークンを付けてPOSTする", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await postComplete({
      apiBaseUrl: "https://api.example.com",
      internalToken: "secret-token",
      sessionId: "ses_1",
      body,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/sessions/ses_1/complete");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer secret-token");
  });

  it("失敗したらエラーにする(呼び出し側でログに残す)", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    await expect(
      postComplete({
        apiBaseUrl: "https://api.example.com",
        internalToken: "secret-token",
        sessionId: "ses_1",
        body,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/500/);
  });

  // 一瞬の失敗でカルテが永久に表に出ないのを避ける(/complete は冪等)
  it("5xxと通信エラーは送り直す", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));

    await postComplete({
      apiBaseUrl: "https://api.example.com",
      internalToken: "secret-token",
      sessionId: "ses_1",
      body,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  // トークンずれ・契約違反は何度送っても同じ
  it("4xxは送り直さない", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    await expect(
      postComplete({
        apiBaseUrl: "https://api.example.com",
        internalToken: "wrong-token",
        sessionId: "ses_1",
        body,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
