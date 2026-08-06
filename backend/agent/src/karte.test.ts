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
  it("許可リスト外のtopic_idが付いた穴を落とす", () => {
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
    expect(guarded.holes.map((hole) => hole.topic_id)).toEqual(["M1-NIJI-HANBETSU"]);
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
