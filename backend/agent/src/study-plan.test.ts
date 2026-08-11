import type { PlanTurn, StudyPlan } from "@ai-sensei/contract";
import { describe, expect, it, vi } from "vitest";
import {
  type PlanFacts,
  buildTemplatePlan,
  inspectPlanTurn,
  postPlanComplete,
} from "./study-plan.ts";

function turn(): PlanTurn & { plan: NonNullable<PlanTurn["plan"]> } {
  return {
    speech: "じゃあ、こんな感じでどう?",
    plan: {
      intake: {
        exam_name: "2学期の中間",
        exam_date: "2026-09-10",
        scope: {
          topic_ids: ["M2-SANKAKU-KAHO"],
          said: "数IIの三角関数、教科書120〜150ページ",
        },
        materials: ["4STEP"],
      },
      days: [
        {
          date: "2026-09-01",
          items: [
            {
              topic_id: "M2-SANKAKU-KAHO",
              what: "4STEPの加法定理の例題を一周",
              material: 0,
              minutes: 40,
            },
          ],
        },
      ],
      revision: null,
    },
  };
}

function inspect(value: unknown, finalAttempt = false, currentPlan: StudyPlan | null = null) {
  return inspectPlanTurn(JSON.stringify(value), {
    locale: "ja",
    today: "2026-08-24",
    currentPlan,
    finalAttempt,
  });
}

describe("計画ターンの検査", () => {
  it("聞き取り途中はplan=nullの短い発話だけを通す", () => {
    expect(inspect({ speech: "範囲は?", plan: null })).toMatchObject({
      kind: "question",
      turn: { speech: "範囲は?", plan: null },
    });
  });

  it("範囲外の割り当ては1回目に再生成させる", () => {
    const value = turn();
    value.plan.days[0]!.items[0]!.topic_id = "M2-ZUKEI-ENCHOKU";
    expect(inspect(value)).toMatchObject({ kind: "repair", reason: "topic_out_of_scope" });
  });

  it("再生成後も混ざった範囲外項目だけを落とし、使える項目は残す", () => {
    const value = turn();
    value.plan.days[0]!.items.push({
      topic_id: "M2-ZUKEI-ENCHOKU",
      what: "円と直線もやる",
      material: null,
      minutes: 20,
    });
    const result = inspect(value, true);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.filtered_items).toBe(1);
    expect(result.turn.plan.days[0]?.items.map((item) => item.topic_id)).toEqual([
      "M2-SANKAKU-KAHO",
    ]);
  });

  it("全部の割り当てが使えなければ、聞き取った事実でテンプレへ縮退する", () => {
    const value = turn();
    value.plan.days[0]!.items[0]!.topic_id = "M2-ZUKEI-ENCHOKU";
    const result = inspect(value, true);
    expect(result).toMatchObject({ kind: "fallback", reason: "empty_after_filter" });
    if (result.kind !== "fallback") return;
    expect(result.facts.intake.scope.said).toBe(value.plan.intake.scope.said);
  });

  it("範囲そのものが捏造なら、狭めたテンプレを作らず聞き直す", () => {
    const value = turn();
    value.plan.intake.scope.topic_ids = ["M2-SONZAI-SHINAI"];
    expect(inspect(value, true)).toMatchObject({ kind: "repair", reason: "unknown_topic_id" });
  });

  it("今日より前の割り当てを再生成させる", () => {
    const value = turn();
    value.plan.days[0]!.date = "2026-08-20";
    expect(inspect(value)).toMatchObject({ kind: "repair", reason: "past_day" });
  });

  it("構造が壊れた2回目も、intakeが読めればテンプレへ落ちる", () => {
    const value = turn() as unknown as { plan: { days: { items: { minutes: number }[] }[] } };
    value.plan.days[0]!.items[0]!.minutes = 900;
    expect(inspect(value)).toMatchObject({ kind: "repair", reason: "invalid_shape" });
    expect(inspect(value, true)).toMatchObject({ kind: "fallback", reason: "invalid_shape" });
  });
});

describe("定型テンプレ", () => {
  const facts: PlanFacts = {
    intake: turn().plan.intake,
    revision: null,
  };

  it("範囲と手持ち教材だけで、4日ごとに休みを置く", () => {
    const plan = buildTemplatePlan({ facts, today: "2026-09-01", locale: "ja" });
    expect(plan.days).toHaveLength(10);
    expect(plan.days[3]?.items).toEqual([]);
    expect(plan.days[0]?.items[0]).toMatchObject({
      topic_id: "M2-SANKAKU-KAHO",
      material: 0,
      minutes: 30,
    });
    expect(JSON.stringify(plan)).not.toMatch(/score|accuracy|percent|達成率/iu);
  });

  it("組み直しのテンプレは本人の言葉を保ち、初回より軽くする", () => {
    const plan = buildTemplatePlan({
      facts: {
        ...facts,
        revision: { reason: "behind", said: "風邪ひいて3日できなかった" },
      },
      today: "2026-09-06",
      locale: "ja",
    });
    expect(plan.revision?.said).toBe("風邪ひいて3日できなかった");
    expect(plan.days[0]?.items[0]?.minutes).toBe(20);
  });
});

describe("計画completeの送信", () => {
  const body = {
    plan: turn().plan,
    source: "senpai" as const,
    duration_seconds: 120,
    ended_reason: "completed" as const,
  };

  it("一時的な500を再送する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("down", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    await postPlanComplete({
      apiBaseUrl: "https://api.example.com",
      internalToken: "secret",
      planSessionId: "pls_1",
      body,
      fetchImpl,
      sleep: async () => undefined,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/plans/pls_1/complete");
  });

  it("契約違反の4xxは再送しない", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(
      postPlanComplete({
        apiBaseUrl: "https://api.example.com",
        internalToken: "secret",
        planSessionId: "pls_1",
        body,
        fetchImpl,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
