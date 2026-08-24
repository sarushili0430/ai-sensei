import type { CompleteSessionResponse, CreateSessionResponse } from "@ai-sensei/contract";
import { completeSessionResponseSchema } from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  type TestServices,
  createSessionForm,
  internalToken,
  testBindings,
  testDeviceId,
  testServices,
} from "../test-support.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

async function startSession(meta: Record<string, unknown> = {}): Promise<string> {
  const response = await app.request(
    "/v1/sessions",
    {
      method: "POST",
      body: createSessionForm(meta),
      headers: { "x-device-id": testDeviceId },
    },
    bindings,
  );
  return ((await response.json()) as CreateSessionResponse).session_id;
}

/** 実運用どおり、解析後に `/start` で日次時間を仮押さえしてから返す。 */
async function startConversation(meta: Record<string, unknown> = {}): Promise<string> {
  const sessionId = await startSession(meta);
  const response = await app.request(
    `/v1/sessions/${sessionId}/start`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": testDeviceId,
      },
      body: JSON.stringify({ locale: "ja" }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  return sessionId;
}

const practiceProblemDraft = {
  topic_id: "M1-NIJI-HANBETSU",
  question: "判別式を使うと実数解の個数がわかるのはなぜ?",
  answer: "判別式の符号が二次方程式の実数解の個数に対応するから",
};

function complete(
  sessionId: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = { authorization: `Bearer ${internalToken}` },
) {
  return app.request(
    `/v1/sessions/${sessionId}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        transcript: [
          { role: "assistant", text: "なんで距離で比べたんですか?", at_ms: 1000 },
          { role: "user", text: "半径と比べたかったからです", at_ms: 8000 },
        ],
        practice_problem: practiceProblemDraft,
        board_id: "brd_board_1",
        duration_seconds: 268,
        ended_reason: "understood",
        ...body,
      }),
    },
    bindings,
  );
}

describe("POST /v1/sessions/{id}/complete", () => {
  it("復習問題を保存し、正解を伏せた契約どおりのレスポンスを返す", async () => {
    const sessionId = await startSession();
    const response = await complete(sessionId);
    expect(response.status).toBe(201);

    const body = (await response.json()) as CompleteSessionResponse;
    const parsed = completeSessionResponseSchema.safeParse(body);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    expect(body.practice_problem).toMatchObject({
      session_id: sessionId,
      board_id: "brd_board_1",
      topic_id: practiceProblemDraft.topic_id,
      question: practiceProblemDraft.question,
    });
    // 正解を生徒へ返すと、解き直さず写して終われてしまい、採点つき復習が成立しない。
    expect(body.practice_problem).not.toHaveProperty("answer");
    expect(body).not.toHaveProperty("karte");
    expect(body).not.toHaveProperty("review_schedule");
  });

  it("完了実績で仮押さえを精算し、返った未使用時間を limits に載せる", async () => {
    const sessionId = await startConversation();

    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;
    expect(body.limits).toEqual({
      max_seconds: 1200,
      remaining_seconds_today: 932,
      lesson_allowed_today: true,
    });
  });

  it("内部トークンがなければ401(agentからの呼び出しのみ許す)", async () => {
    const sessionId = await startSession();
    const response = await complete(sessionId, {}, {});
    expect(response.status).toBe(401);
  });

  it("存在しないセッションは404", async () => {
    const response = await complete("ses_nonexistent");
    expect(response.status).toBe(404);
  });

  it("「わかった」の直後は翌日を避け、3日後・7日後だけ予約する", async () => {
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;

    expect(body.practice_schedule.map((entry) => entry.step)).toEqual([2, 3]);
    expect(body.practice_schedule.map((entry) => entry.days)).toEqual([3, 7]);
    expect(body.practice_schedule.map((entry) => entry.scheduled_at)).toEqual([
      "2026-08-06T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]);
    expect(services.scheduler.scheduledPractice.map((entry) => entry.step)).toEqual([2, 3]);
    expect(services.scheduler.scheduledPractice).toHaveLength(2);
  });

  it("通知には問題の単元名を渡す", async () => {
    const sessionId = await startSession();
    await complete(sessionId);
    // 問題文をそのまま通知へ出すと正解の手掛かりになりうるので、見出しは単元名に閉じる。
    expect(services.scheduler.scheduledPractice[0]?.topicLabel).toContain("判別式");
  });

  /**
   * 範囲外の問題は、topic_idだけを主単元へ付け替えると中身との対応が嘘になる。
   * 穴の頃と違って「本人が詰まった事実」は無いので、問題ごと落とさないと
   * 教えていない内容が3日後に届く。
   */
  it("許可リスト外のtopic_idを持つ問題は、付け替えず保存しない", async () => {
    const sessionId = await startSession();
    const body = (await (
      await complete(sessionId, {
        practice_problem: {
          topic_id: "MB-SURETSU-SIGMA",
          question: "Σの意味は?",
          answer: "総和を表す記号",
        },
      })
    ).json()) as CompleteSessionResponse;

    expect(body.practice_problem).toBeNull();
    expect(body.practice_schedule).toEqual([]);
    expect(services.repository.practiceProblems.size).toBe(0);
    expect(services.repository.practiceSchedules).toEqual([]);
    expect(services.scheduler.scheduledPractice).toEqual([]);
  });

  /**
   * 「わかった」以外は到達の宣言ではない。そこで問題を作ると、時間切れで
   * 教わりきれなかった内容まで復習として届き、離脱したことが罰になる。
   */
  it("時間切れで降り、問題の欄がない回には何も作らない", async () => {
    const sessionId = await startSession();
    const body = (await (
      await complete(sessionId, {
        ended_reason: "timeout",
        practice_problem: undefined,
        board_id: undefined,
      })
    ).json()) as CompleteSessionResponse;

    expect(body.practice_problem).toBeNull();
    expect(body.practice_schedule).toEqual([]);
    expect(body.show_paywall).toBe(false);
    expect(services.repository.practiceProblems.size).toBe(0);
    expect(services.scheduler.scheduledPractice).toEqual([]);
  });

  it("無料ユーザーにも復習問題を返す(問題を解くこと自体は無料)", async () => {
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;
    expect(body.practice_problem?.question).toBe(practiceProblemDraft.question);
  });

  it("Premiumでも正解は応答へ出さず、ペイウォールも出さない", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: null,
    });
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;

    expect(body.practice_problem).not.toHaveProperty("answer");
    expect(body.show_paywall).toBe(false);
  });

  it("初回の復習問題ができたときだけペイウォールを出す", async () => {
    const first = await startSession();
    const firstBody = (await (await complete(first)).json()) as CompleteSessionResponse;
    expect(firstBody.show_paywall).toBe(true);
  });

  it("問題を作れなかった初回ではペイウォールを出さない", async () => {
    const sessionId = await startSession();
    const body = (await (
      await complete(sessionId, {
        ended_reason: "timeout",
        practice_problem: null,
        board_id: undefined,
      })
    ).json()) as CompleteSessionResponse;
    expect(body.show_paywall).toBe(false);
  });

  it("進捗は連続日数と未解答の復習問題を返す", async () => {
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;
    expect(body.progress).toEqual({
      streak_days: 1,
      filled_holes: 0,
      open_holes: 0,
      solved_problems: 0,
      open_problems: 1,
      last_session_date: "2026-08-03",
    });
  });

  it("通知の予約に失敗しても問題を保存し、201を返す", async () => {
    const sessionId = await startSession();
    services.scheduler.schedulePractice = async () => {
      throw new Error("OneSignal down");
    };

    const response = await complete(sessionId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as CompleteSessionResponse;
    expect(body.practice_problem).not.toBeNull();
    expect(body.practice_schedule.map((entry) => entry.step)).toEqual([2, 3]);
    expect(services.repository.practiceSchedules).toHaveLength(2);
    expect(services.repository.practiceSchedules.every((entry) => entry.external_id === null)).toBe(
      true,
    );
  });

  it("スキーマに合わない本文は400", async () => {
    const sessionId = await startSession();
    const response = await complete(sessionId, { ended_reason: "gave_up" });
    expect(response.status).toBe(400);
  });
});

// agentのタイムアウト再送を素通しすると、問題も通知も二重にできてしまう。
describe("再送(冪等性)", () => {
  it("同じセッションを2度completeしても、問題も通知も増えない", async () => {
    const sessionId = await startSession();
    const first = (await (await complete(sessionId)).json()) as CompleteSessionResponse;

    const retry = await complete(sessionId);
    expect(retry.status).toBe(200);
    const second = (await retry.json()) as CompleteSessionResponse;

    expect(second.practice_problem?.id).toBe(first.practice_problem?.id);
    expect(second.practice_schedule).toEqual([]);
    expect(services.repository.practiceProblems.size).toBe(1);
    expect(services.repository.practiceSchedules).toHaveLength(2);
    expect(services.scheduler.scheduledPractice).toHaveLength(2);
  });

  /**
   * 保存物の有無を再送判定にすると、問題を作らなかった回だけ二度目が通る。
   * セッションの完了状態を正本にしておかないと、同じ時間切れが毎回201として走る。
   */
  it("問題のない完了も同じ本文で再送すれば、何も増やさない", async () => {
    const sessionId = await startSession();
    const timeoutBody = {
      ended_reason: "timeout",
      practice_problem: null,
      board_id: undefined,
    };
    const first = await complete(sessionId, timeoutBody);
    expect(first.status).toBe(201);

    const retry = await complete(sessionId, timeoutBody);
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as CompleteSessionResponse;
    expect(body.practice_problem).toBeNull();
    expect(services.repository.practiceProblems.size).toBe(0);
    expect(services.scheduler.scheduledPractice).toEqual([]);
  });

  /**
   * 保存と予約は別の文で、D1 は文をまたいだトランザクションを張らない。
   * あいだで worker が落ちると「問題はあるのに段が1つも無い」行が残り、
   * **約束した3日後・7日後が永久に来ない**。生徒からは「わかったを押したのに
   * 何も届かない」としか見えないので、再送で拾い直す。
   */
  it("段だけ落とした回の再送は、3日後・7日後を予約し直す", async () => {
    const sessionId = await startSession();
    const first = (await (await complete(sessionId)).json()) as CompleteSessionResponse;
    const problemId = first.practice_problem?.id;
    expect(problemId).toBeDefined();

    // 予約の直前で落ちた状態を作る。問題だけが残り、段は1本も無い。
    services.repository.practiceSchedules.length = 0;
    services.scheduler.scheduledPractice.length = 0;

    const retry = await complete(sessionId);
    expect(retry.status).toBe(200);
    const second = (await retry.json()) as CompleteSessionResponse;

    expect(second.practice_problem?.id).toBe(problemId);
    expect(second.practice_schedule.map((entry) => entry.days)).toEqual([3, 7]);
    expect(services.repository.practiceSchedules).toHaveLength(2);
    expect(services.scheduler.scheduledPractice).toHaveLength(2);
    // 問題そのものは増やさない。
    expect(services.repository.practiceProblems.size).toBe(1);
  });

  /**
   * 外部IDが null の行は「予約を試みて失敗した記録」で、これは既知の縮退。
   * ここでやり直すと、成功していた分まで二重に届く。
   */
  it("段が1本でも残っていれば、予約はやり直さない", async () => {
    const sessionId = await startSession();
    await complete(sessionId);
    services.repository.practiceSchedules.length = 1;
    services.scheduler.scheduledPractice.length = 0;

    const retry = await complete(sessionId);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as CompleteSessionResponse).practice_schedule).toEqual([]);
    expect(services.scheduler.scheduledPractice).toEqual([]);
  });
});

describe("GET /v1/sessions/{id}/result", () => {
  it("復習問題ができる前は202を返す(後から確かめる呼び出しは待てる)", async () => {
    const sessionId = await startSession();
    const response = await app.request(
      `/v1/sessions/${sessionId}/result`,
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    expect(response.status).toBe(202);
  });

  it("完了済みなら復習問題と進捗を返す", async () => {
    const sessionId = await startSession();
    await complete(sessionId);

    const response = await app.request(
      `/v1/sessions/${sessionId}/result`,
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as CompleteSessionResponse;
    expect(body.practice_problem?.question).toBe(practiceProblemDraft.question);
    expect(body.practice_schedule).toEqual([]);
    expect(body.progress.streak_days).toBe(1);
  });

  it("採点用の正解は保存するが、結果取得でも生徒へ返さない", async () => {
    const sessionId = await startSession();
    await complete(sessionId);

    const stored = await services.repository.getPracticeProblemBySession(sessionId);
    expect(stored?.answer).toBe(practiceProblemDraft.answer);

    const response = await app.request(
      `/v1/sessions/${sessionId}/result`,
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    const body = (await response.json()) as CompleteSessionResponse;
    expect(body.practice_problem?.question).toBe(practiceProblemDraft.question);
    expect(body.practice_problem).not.toHaveProperty("answer");
  });

  it("他人のセッションは見せない", async () => {
    const sessionId = await startSession();
    await complete(sessionId);

    const response = await app.request(
      `/v1/sessions/${sessionId}/result`,
      { headers: { "x-device-id": "11111111-2222-3333-4444-555555555555" } },
      bindings,
    );
    expect(response.status).toBe(404);
  });
});

/**
 * 通知の言語は端末の設定ではなく、問題のtopic_idが属する課程で決まる。
 * 問題の文言もその課程の言語なので、ここを取り違えると英語の問題に日本語の
 * 通知が届く。
 */
describe("通知の言語", () => {
  it("英語の課程の問題は、英語で予約する", async () => {
    const sessionId = await startSession({ locale: "en" });
    const response = await complete(sessionId, {
      practice_problem: {
        topic_id: "A1-QUAD-SOLVE",
        question: "Why does the discriminant tell us the number of real roots?",
        answer: "Its sign determines how many real roots the quadratic has.",
      },
    });
    expect(response.status).toBe(201);

    expect(services.scheduler.scheduledPractice).toHaveLength(2);
    for (const entry of services.scheduler.scheduledPractice) {
      expect(entry.locale).toBe("en");
    }
  });

  it("日本の課程の問題は、日本語のまま", async () => {
    const sessionId = await startSession();
    await complete(sessionId);

    expect(services.scheduler.scheduledPractice).toHaveLength(2);
    for (const entry of services.scheduler.scheduledPractice) {
      expect(entry.locale).toBe("ja");
    }
  });
});
