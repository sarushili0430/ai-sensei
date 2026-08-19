import {
  type CompleteSessionRequest,
  completeSessionRequestSchema,
  karteDraftSchema,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import { describe, expect, it, vi } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  type LlmClient,
  applyGuardrails,
  buildKarte,
  createAnthropicClient,
  emptyKarte,
  extractJson,
  postComplete,
  withUncertaintyHole,
} from "./karte.ts";
import { sessionMetadataJson } from "./test-support.ts";

const context = readSessionContext(
  sessionMetadataJson({
    session_id: "ses_1",
    problem_text: "x^2 - 3x + 2 = 0 を解け",
    visible_work: "- 因数分解しかけて止まっている",
    max_seconds: 300,
    photo_summary: "円と直線の位置関係",
    question_seeds: "",
    allowed_topics: "- M2-ZUKEI-ENCHOKU",
    allowed_topic_ids: ["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"],
    is_premium: false,
  }),
);

const premiumContext = readSessionContext(
  sessionMetadataJson({
    session_id: "ses_2",
    problem_text: "x^2 - 3x + 2 = 0 を解け",
    visible_work: "- 因数分解しかけて止まっている",
    max_seconds: 900,
    photo_summary: "",
    question_seeds: "",
    allowed_topics: "",
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

  it("プロンプトに問題文・写真の要約・transcriptを渡す", async () => {
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
    expect(system).toContain("x^2 - 3x + 2 = 0 を解け");
    expect(system).toContain("円と直線の位置関係");
    expect(system).toContain("問題文を読み上げただけ");
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

describe("createAnthropicClient", () => {
  // ここで詰まると `/complete` が永久に送られない。アプリ側は `/result` が
  // 202を返し続けるので、「取りに行っています…」のまま固まったように見える。
  // 待ち続けるくらいなら、諦めて空のカルテで送るほうがまし。
  it("カルテを書く呼び出しに上限を付ける", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 }),
    );

    await createAnthropicClient({
      apiKey: "sk-test",
      model: "claude-sonnet-5",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).complete({ system: "s", user: "u", maxTokens: 100 });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

  // 返事の来ない接続を掴んだままにすると、送り直しにも入れないままジョブが
  // 終わる。アプリからは「カルテがいつまでも来ない」としか見えない。
  it("返事を待ち続けないよう、1回ぶんの上限を付ける", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await postComplete({
      apiBaseUrl: "https://api.example.com",
      internalToken: "secret-token",
      sessionId: "ses_1",
      body,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

/**
 * 英語のセッション。プロンプトは日本語の本文に「英語で答えて」を足すのではなく、
 * **英語のプロンプトそのもの**を使う(ペルソナも禁止事項も英語で書かれている)。
 */
describe("英語のセッション", () => {
  const englishContext = readSessionContext(
    sessionMetadataJson({
      session_id: "ses_en",
      problem_text: "Solve x^2 - 3x + 2 = 0.",
      visible_work: "- 因数分解しかけて止まっている",
      locale: "en",
      max_seconds: 300,
      photo_summary: "A line-and-circle problem",
      question_seeds: "",
      allowed_topics: "- A2-COORD-CIRCLE",
      allowed_topic_ids: ["A2-COORD-CIRCLE", "A1-QUAD-SOLVE"],
      is_premium: false,
    }),
  );

  it("英語のカルテ生成プロンプトを使い、日本語を混ぜない", async () => {
    const seen: { system: string; user: string }[] = [];
    const llm: LlmClient = {
      complete: async (input) => {
        seen.push({ system: input.system, user: input.user });
        return JSON.stringify({
          said_well: ["Explained why the distance is compared with the radius"],
          holes: [
            {
              topic_id: "A1-QUAD-SOLVE",
              desc: "the explanation stopped at why the discriminant is used",
              severity: "medium",
            },
          ],
          term_notes: [],
          followup_question: null,
        });
      },
    };

    const karte = await buildKarte({
      context: englishContext,
      transcript: [{ role: "user", text: "I compared the distance", at_ms: 1000 }],
      llm,
    });

    expect(karte.holes[0]?.topic_id).toBe("A1-QUAD-SOLVE");
    expect(seen[0]?.system).toContain('Build a "karte" from the whole conversation transcript');
    expect(seen[0]?.system).toContain("Student: I compared the distance");
    expect(seen[0]?.system).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(seen[0]?.user).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  /**
   * 別の課程のタグが付いても、**穴は捨てずにこのセッションの主単元へ付け替える**。
   * 捨てると「今日は、止まらずに説明できました」に化けるため(develop の判断)。
   * ここで見たいのは、付け替え先が**同じ課程のID**になっていること —
   * 英語のセッションのカルテに日本語の単元が残ると、復習の通知まで日本語になる。
   */
  it("別の課程のタグは、英語の課程の主単元へ付け替える", () => {
    const filtered = applyGuardrails(
      {
        said_well: [],
        holes: [
          { topic_id: "A2-COORD-CIRCLE", desc: "the explanation stopped here", severity: "low" },
          { topic_id: "M2-ZUKEI-ENCHOKU", desc: "別の課程のタグ", severity: "low" },
        ],
        term_notes: [],
      },
      englishContext,
    );

    expect(filtered.holes.map((hole) => hole.topic_id)).toEqual([
      "A2-COORD-CIRCLE",
      "A2-COORD-CIRCLE",
    ]);
    for (const hole of filtered.holes) {
      expect(localeOfTopicId(hole.topic_id), hole.topic_id).toBe("en");
    }
  });

  /**
   * 「わからない」と言ったのに穴ゼロ、を英語でも出さない。
   * 発話の検出は言語をまたぐが、**足す穴の文言とタグはその課程のもの**になる。
   */
  it("英語で「わからない」と言われたら、英語の穴を足す", () => {
    const karte = withUncertaintyHole(emptyKarte(), englishContext, [
      { role: "assistant", text: "Why did you use the discriminant?", at_ms: 1000 },
      { role: "user", text: "I don't know, sorry", at_ms: 4000 },
    ]);

    expect(karte.holes).toHaveLength(1);
    expect(karte.holes[0]?.topic_id).toBe("A2-COORD-CIRCLE");
    expect(karte.holes[0]?.desc).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(karte.holes[0]?.evidence).toBe("I don't know, sorry");
  });
});
