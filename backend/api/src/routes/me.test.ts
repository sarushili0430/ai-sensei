import type {
  ParentReportResponse,
  PracticeAnswerResponse,
  PracticeQueueItem,
  PracticeQueueResponse,
  ProgressResponse,
  ReviewAnswerResponse,
  ReviewQueueResponse,
} from "@ai-sensei/contract";
import {
  parentReportQuoteMaxCount,
  parentReportResponseSchema,
  practiceAnswerResponseSchema,
  practiceQueueItemSchema,
  practiceQueueResponseSchema,
  progressResponseSchema,
  reviewAnswerResponseSchema,
  reviewQueueResponseSchema,
} from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type {
  HoleRecord,
  KarteRecord,
  PracticeAttemptRecord,
  PracticeProblemRecord,
  SessionRecord,
} from "../repository/types.ts";
import { type TestServices, testBindings, testDeviceId, testServices } from "../test-support.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

function get(path: string) {
  return app.request(path, { headers: { "x-device-id": testDeviceId } }, bindings);
}

function answerReview(holeId: string, body: unknown, deviceId = testDeviceId) {
  return app.request(
    `/v1/me/reviews/${holeId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function answerPractice(problemId: string, body: unknown, deviceId = testDeviceId) {
  return app.request(
    `/v1/me/practice/${problemId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function sessionRow(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    device_id: testDeviceId,
    kind: "new",
    status: "open",
    created_at: "2026-08-03T13:00:00.000Z",
    completed_at: null,
    local_date: "2026-08-03",
    photo_key: null,
    topic_ids: [],
    hole_id: null,
    practice_problem_id: null,
    duration_seconds: null,
    context: null,
    started_at: null,
    max_seconds: null,
    quota_settled_at: null,
    analysis_count: 1,
    ...overrides,
  };
}

/** 会話まで進んだセッション。**時間集計に入るのはこれだけ**(`started_at` が入っている)。 */
async function startedSession(id: string, overrides: Partial<SessionRecord> = {}): Promise<void> {
  await services.repository.createSession({
    session: sessionRow(id, { started_at: "2026-08-03T13:00:00.000Z", ...overrides }),
    maxAnalysesPerDay: 99,
  });
}

async function seedHole(overrides: Partial<HoleRecord> = {}): Promise<HoleRecord> {
  const karte: KarteRecord = {
    id: "kar_seed",
    session_id: "ses_seed",
    device_id: testDeviceId,
    created_at: "2026-07-31T11:00:00.000Z",
    topic_ids: ["M1-NIJI-GURAFU"],
    said_well: [],
    term_notes: [],
    followup_question: null,
  };
  const hole: HoleRecord = {
    id: "hol_seed",
    device_id: testDeviceId,
    karte_id: karte.id,
    topic_id: "M1-NIJI-GURAFU",
    desc: "平方完成を「なぜ」するのか、で説明が止まった",
    severity: "high",
    evidence: null,
    quiz: null,
    status: "open",
    created_at: "2026-07-31T11:00:00.000Z",
    filled_at: null,
    ...overrides,
  };
  await services.repository.insertKarte(karte, [hole]);
  return hole;
}

async function seedPracticeProblem(
  overrides: Partial<PracticeProblemRecord> = {},
): Promise<PracticeProblemRecord> {
  const problem: PracticeProblemRecord = {
    id: "prb_seed",
    device_id: testDeviceId,
    session_id: "ses_prb_seed",
    board_id: "brd_seed",
    topic_id: "M1-NIJI-HANBETSU",
    question: "判別式の符号から何がわかる?",
    answer: "二次方程式の実数解の個数",
    created_at: "2026-07-31T11:00:00.000Z",
    ...overrides,
  };
  await services.repository.insertPracticeProblem(problem);
  return problem;
}

async function seedPracticeAttempt(
  problemId: string,
  overrides: Partial<PracticeAttemptRecord> = {},
): Promise<PracticeAttemptRecord> {
  const attempt: PracticeAttemptRecord = {
    id: `att_${problemId}`,
    problem_id: problemId,
    answered_at: "2026-08-02T11:00:00.000Z",
    response: "判別式の符号で実数解の個数がわかる",
    verdict: "correct",
    graded_by: "stub",
    comment: "いいね",
    ...overrides,
  };
  await services.repository.insertPracticeAttempt(attempt);
  return attempt;
}

async function makePremium(): Promise<void> {
  await services.repository.ensureUser(testDeviceId, new Date());
  await services.repository.setPremium({
    deviceId: testDeviceId,
    isPremium: true,
    expiresAt: null,
    rcAppUserId: null,
  });
}

describe("GET /v1/me/progress", () => {
  it("初回でも0で返す(履歴がなくてもエラーにしない)", async () => {
    const response = await get("/v1/me/progress");
    expect(response.status).toBe(200);

    const body = (await response.json()) as ProgressResponse;
    expect(progressResponseSchema.safeParse(body).success).toBe(true);
    expect(body.progress).toEqual({
      streak_days: 0,
      filled_holes: 0,
      open_holes: 0,
      solved_problems: 0,
      open_problems: 0,
      last_session_date: null,
    });
    expect(body.limits.lesson_allowed_today).toBe(true);
    expect(body.limits.remaining_seconds_today).toBe(1200);
  });

  /**
   * 移行期は同じ端末に穴と復習問題が並存する。ひとつの成果数へ足すと、
   * 移行前後の同じ学習を二度数えてホームの数字が急に増える。
   */
  it("穴と復習問題を別の数字で返し、二重計上しない", async () => {
    await seedHole({ status: "filled", filled_at: "2026-08-02T11:00:00.000Z" });
    const problem = await seedPracticeProblem();
    await seedPracticeAttempt(problem.id);

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.progress).toEqual({
      streak_days: 0,
      filled_holes: 1,
      open_holes: 0,
      solved_problems: 1,
      open_problems: 0,
      last_session_date: null,
    });
  });

  it("無料ユーザーが今日の1200秒を仮押さえしたあとは授業不可を返す", async () => {
    await startedSession("ses_today", { status: "open" });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.lesson_allowed_today).toBe(false);
  });

  it("完了実績と進行中の仮押さえを両方引いて残り時間を返す", async () => {
    await startedSession("ses_completed", {
      status: "completed",
      started_at: "2026-08-03T13:00:00.000Z",
      max_seconds: 1200,
      duration_seconds: 300,
      completed_at: "2026-08-03T13:05:00.000Z",
      quota_settled_at: "2026-08-03T13:05:00.000Z",
    });
    await startedSession("ses_active", {
      started_at: "2026-08-03T13:20:00.000Z",
      max_seconds: 600,
    });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.remaining_seconds_today).toBe(300);
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  it("未完了のまま寿命を過ぎた回は、仮押さえ額を実績として自動精算する", async () => {
    await startedSession("ses_expired", {
      started_at: "2026-08-03T13:00:00.000Z",
      max_seconds: 600,
    });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.remaining_seconds_today).toBe(600);
    expect(await services.repository.getSession("ses_expired")).toMatchObject({
      duration_seconds: 600,
      quota_settled_at: "2026-08-03T13:24:07.000Z",
    });
  });

  it("JSTの前日に使った時間は、今日の残高から引かない", async () => {
    await startedSession("ses_yesterday", {
      local_date: "2026-08-02",
      status: "completed",
      max_seconds: 1200,
      duration_seconds: 1200,
      completed_at: "2026-08-02T13:20:00.000Z",
      quota_settled_at: "2026-08-02T13:20:00.000Z",
    });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.remaining_seconds_today).toBe(1200);
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  /**
   * 写真を読んだだけのセッションは行としては在るが、先輩とは1度も話していない。
   * ここを行数で数えていた頃は、撮って単元を確かめただけでホームの導線が閉じた。
   */
  it("写真を読んだだけで会話していないセッションは数えない", async () => {
    await services.repository.createSession({
      session: sessionRow("ses_analyzed", { started_at: null }),
      maxAnalysesPerDay: 5,
    });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  it("Premiumはフェアユース枠が残っていれば授業可で、無料と同じ20分を返す", async () => {
    await makePremium();
    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.is_premium).toBe(true);
    expect(body.limits.lesson_allowed_today).toBe(true);
    expect(body.limits.max_seconds).toBe(1200);
  });

  it("Premiumも3600秒を使ったあとは今日の授業不可だけを返す", async () => {
    await makePremium();
    for (let count = 0; count < 3; count += 1) {
      await startedSession(`ses_premium_${count}`, {
        status: "completed",
        completed_at: "2026-08-03T13:20:00.000Z",
        duration_seconds: 1200,
      });
    }

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.is_premium).toBe(true);
    expect(body.limits).toEqual({
      max_seconds: 1200,
      remaining_seconds_today: 0,
      lesson_allowed_today: false,
    });
  });

  it("デバイスIDがなければ401", async () => {
    expect((await app.request("/v1/me/progress", {}, bindings)).status).toBe(401);
  });
});

/**
 * クローズドβの開放(`BETA_OPEN_ACCESS_UNTIL`)。
 *
 * テスターに「無料で使い放題」と伝えている以上、**アプリが課金導線を出さない**
 * ところまでがこの設定の仕事。判定はサーバに1本化されているので、
 * ここが通れば復習・プラン・親レポート・ペイウォールの出し分けも同じ答えになる。
 */
describe("クローズドβの開放中", () => {
  const betaBindings = testBindings({
    BETA_OPEN_ACCESS_UNTIL: "2026-09-30T15:00:00.000Z",
    BETA_SECONDS_PER_DAY: "12000",
  });
  const getAsBetaTester = (path: string) =>
    app.request(path, { headers: { "x-device-id": testDeviceId } }, betaBindings);

  it("課金していない人にも is_premium: true を返す(アプリの課金導線が出ない)", async () => {
    const body = (await (await getAsBetaTester("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.is_premium).toBe(true);
    expect(body.limits).toEqual({
      max_seconds: 1200,
      remaining_seconds_today: 12000,
      lesson_allowed_today: true,
    });
  });

  it("通常の1200秒を仮押さえしても、βの持ち時間はまだ残る", async () => {
    await startedSession("ses_today", { status: "open" });

    const body = (await (await getAsBetaTester("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  it("使い放題でも上限は外さない(12000秒使ったら今日はおしまい)", async () => {
    for (let count = 0; count < 10; count += 1) {
      await startedSession(`ses_beta_${count}`, {
        status: "completed",
        completed_at: "2026-08-03T13:20:00.000Z",
        duration_seconds: 1200,
      });
    }

    const body = (await (await getAsBetaTester("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.lesson_allowed_today).toBe(false);
  });

  it("親レポートも開く", async () => {
    const body = (await (
      await getAsBetaTester("/v1/me/parent-report")
    ).json()) as ParentReportResponse;
    expect(body.requires_premium).toBe(false);
  });

  it("期限を過ぎたら通常営業に戻る", async () => {
    const expired = testBindings({ BETA_OPEN_ACCESS_UNTIL: "2026-08-01T00:00:00.000Z" });
    const response = await app.request(
      "/v1/me/progress",
      { headers: { "x-device-id": testDeviceId } },
      expired,
    );

    const body = (await response.json()) as ProgressResponse;
    expect(body.is_premium).toBe(false);
  });
});

describe("GET /v1/me/practice", () => {
  /**
   * 放置された問題から声をかけないと、新しい問題に押し流されて永遠に解かれない。
   * 一度でも正解した問題は努力の積み上げなので、後で間違えても solved から戻さない。
   */
  it("未解決を古い順に返し、一度正解した問題をitemsから外してsolvedへ回す", async () => {
    const old = await seedPracticeProblem({
      id: "prb_old",
      session_id: "ses_old",
      created_at: "2026-07-30T11:00:00.000Z",
      question: "古い問題",
    });
    const solved = await seedPracticeProblem({
      id: "prb_solved",
      session_id: "ses_solved",
      created_at: "2026-07-31T11:00:00.000Z",
      question: "解けた問題",
    });
    const recent = await seedPracticeProblem({
      id: "prb_recent",
      session_id: "ses_recent",
      created_at: "2026-08-02T11:00:00.000Z",
      question: "新しい問題",
    });
    await seedPracticeAttempt(old.id, {
      id: "att_old",
      verdict: "incorrect",
      answered_at: "2026-08-01T11:00:00.000Z",
    });
    await seedPracticeAttempt(solved.id, {
      id: "att_solved",
      verdict: "correct",
      answered_at: "2026-08-02T11:00:00.000Z",
    });
    await seedPracticeAttempt(recent.id, {
      id: "att_recent",
      verdict: "unclear",
      answered_at: "2026-08-03T11:00:00.000Z",
    });

    const response = await get("/v1/me/practice");
    expect(response.status).toBe(200);
    const body = (await response.json()) as PracticeQueueResponse;
    expect(practiceQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body.items.map((entry) => entry.problem.id)).toEqual(["prb_old", "prb_recent"]);
    expect(body.items.map((entry) => entry.last_verdict)).toEqual(["incorrect", "unclear"]);
    expect(body.solved.map((entry) => entry.problem.id)).toEqual(["prb_solved"]);
    expect(body.items[0]?.problem).not.toHaveProperty("answer");
    expect(body.solved[0]?.problem).not.toHaveProperty("answer");
    expect(body).not.toHaveProperty("lesson_requires_premium");
  });
});

describe("GET /v1/me/practice/{problemId}", () => {
  /**
   * **通知の宛先はここで解決する。**
   *
   * 正解した問題にも7日後の通知は届く(作成時に決めた段は取り消さない)。
   * その通知をタップした先はリストの `items` に無い(解けた問題は `solved` へ回る)し、
   * `solved` にも直近30件しか載らない。リストから探させると、
   * **よく解く生徒ほど自分の通知を開けなくなる。**
   */
  it("解けた問題でも1問だけ引ける(通知はリストに無い問題にも届く)", async () => {
    const problem = await seedPracticeProblem();
    await seedPracticeAttempt(problem.id, {
      id: "att_correct",
      verdict: "correct",
      answered_at: "2026-08-02T11:00:00.000Z",
    });

    const queue = (await (await get("/v1/me/practice")).json()) as PracticeQueueResponse;
    expect(queue.items).toEqual([]);

    const response = await get(`/v1/me/practice/${problem.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PracticeQueueItem;
    expect(practiceQueueItemSchema.safeParse(body).success).toBe(true);
    expect(body.problem.id).toBe(problem.id);
    expect(body.last_verdict).toBe("correct");
    expect(body.topic_label).not.toHaveLength(0);
    // 採点用の正解は、単問取得でも生徒へ返さない。
    expect(body.problem).not.toHaveProperty("answer");
    expect(JSON.stringify(body)).not.toContain(problem.answer);
  });

  it("他人の問題には触れず404を返す", async () => {
    const problem = await seedPracticeProblem({ device_id: "someone-else" });
    expect((await get(`/v1/me/practice/${problem.id}`)).status).toBe(404);
    expect((await get("/v1/me/practice/prb_missing")).status).toBe(404);
  });
});

describe("POST /v1/me/practice/{problemId}", () => {
  it("正解は作成時の段を残し、翌日を避けた3日後・7日後を追加する", async () => {
    const problem = await seedPracticeProblem();
    await services.repository.insertPracticeSchedules([
      {
        id: "psc_create_2",
        problem_id: problem.id,
        step: 2,
        scheduled_at: "2026-08-03T11:00:00.000Z",
        external_id: "os_create_2",
      },
      {
        id: "psc_create_3",
        problem_id: problem.id,
        step: 3,
        scheduled_at: "2026-08-07T11:00:00.000Z",
        external_id: "os_create_3",
      },
    ]);
    services.grader.set({ verdict: "correct", comment: "言えてる", gradedBy: "stub-correct" });

    const response = await answerPractice(problem.id, { response: "符号で個数が決まるから" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PracticeAnswerResponse;
    expect(practiceAnswerResponseSchema.safeParse(body).success).toBe(true);
    expect(body.attempt.verdict).toBe("correct");
    expect(body.next_schedule.map((entry) => entry.step)).toEqual([2, 3]);
    expect(body.next_schedule.map((entry) => entry.days)).toEqual([3, 7]);
    expect(body.next_schedule.map((entry) => entry.scheduled_at)).toEqual([
      "2026-08-06T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]);
    expect(services.scheduler.scheduledPractice.map((entry) => entry.step)).toEqual([2, 3]);
    expect(services.scheduler.cancelled).toEqual([]);
    const schedules = await services.repository.listPracticeSchedules(problem.id);
    expect(schedules).toHaveLength(4);
    expect(schedules.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["psc_create_2", "psc_create_3"]),
    );
    expect(services.repository.practiceAttempts).toHaveLength(1);
    expect(body.progress).toMatchObject({ solved_problems: 1, open_problems: 0 });
    // 正解は採点器だけが読み、生徒向けの採点応答へ混ぜない。
    expect(services.grader.graded).toEqual([
      {
        question: problem.question,
        answer: problem.answer,
        response: "符号で個数が決まるから",
        locale: "ja",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(problem.answer);
  });

  it("不正解は翌日・3日後・7日後の3本を予約する", async () => {
    const problem = await seedPracticeProblem();
    services.grader.set({
      verdict: "incorrect",
      comment: "符号と個数をもう一度つなごう",
      gradedBy: "stub-incorrect",
    });

    const body = (await (
      await answerPractice(problem.id, { response: "解の公式そのもの" })
    ).json()) as PracticeAnswerResponse;

    expect(body.attempt.verdict).toBe("incorrect");
    expect(body.next_schedule.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(body.next_schedule.map((entry) => entry.days)).toEqual([1, 3, 7]);
    expect(services.scheduler.scheduledPractice.map((entry) => entry.sendAt)).toEqual([
      "2026-08-04T11:00:00.000Z",
      "2026-08-06T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]);
    expect(body.progress).toMatchObject({ solved_problems: 0, open_problems: 1 });
  });

  /**
   * `unclear` は採点側が読めなかっただけで、生徒の誤りではない。翌日の段へ
   * 倒すとモデルの迷いが生徒への通知になり、既存の3日・7日予約まで動かしてしまう。
   */
  it("判定できずでは1本も足さず、作成時の段をそのまま残す", async () => {
    const problem = await seedPracticeProblem();
    await services.repository.insertPracticeSchedules([
      {
        id: "psc_create_2",
        problem_id: problem.id,
        step: 2,
        scheduled_at: "2026-08-06T11:00:00.000Z",
        external_id: "os_create_2",
      },
      {
        id: "psc_create_3",
        problem_id: problem.id,
        step: 3,
        scheduled_at: "2026-08-10T11:00:00.000Z",
        external_id: "os_create_3",
      },
    ]);
    services.grader.set({
      verdict: "unclear",
      comment: "もう少しだけ書いてみて",
      gradedBy: "stub-unclear",
    });

    const response = await answerPractice(problem.id, { response: "途中の式だけ" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PracticeAnswerResponse;
    expect(body.attempt.verdict).toBe("unclear");
    expect(body.next_schedule).toEqual([]);
    expect(services.scheduler.scheduledPractice).toEqual([]);
    expect(services.scheduler.cancelled).toEqual([]);
    expect(services.repository.practiceAttempts).toHaveLength(1);
    expect(
      (await services.repository.listPracticeSchedules(problem.id)).map((entry) => entry.id),
    ).toEqual(["psc_create_2", "psc_create_3"]);
    expect(body.progress).toMatchObject({ solved_problems: 0, open_problems: 1 });
  });

  it("通知の予約に失敗しても採点履歴を保存し、200を返す", async () => {
    const problem = await seedPracticeProblem();
    services.grader.set({ verdict: "correct", comment: "言えてる", gradedBy: "stub-correct" });
    services.scheduler.schedulePractice = async () => {
      throw new Error("OneSignal down");
    };

    const response = await answerPractice(problem.id, { response: "符号で個数が決まる" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PracticeAnswerResponse;
    expect(body.attempt.verdict).toBe("correct");
    expect(body.next_schedule.map((entry) => entry.step)).toEqual([2, 3]);
    expect(services.repository.practiceAttempts).toHaveLength(1);
    expect(services.repository.practiceSchedules).toHaveLength(2);
    expect(services.repository.practiceSchedules.every((entry) => entry.external_id === null)).toBe(
      true,
    );
  });

  /**
   * POST がタイムアウトしてもアプリは下書きを消さないので、押し直すと
   * 一字一句同じ本文が届く。素通しすると履歴が二重に積まれ、段がもう一組
   * 予約されて**同じ通知が2回届く**。
   */
  it("同じこたえの送り直しは、採点も予約もやり直さない", async () => {
    const problem = await seedPracticeProblem();
    services.grader.set({ verdict: "incorrect", comment: "おしい", gradedBy: "stub" });

    const first = (await (
      await answerPractice(problem.id, { response: "2個だと思う" })
    ).json()) as PracticeAnswerResponse;

    const retry = await answerPractice(problem.id, { response: "2個だと思う" });
    expect(retry.status).toBe(200);
    const second = (await retry.json()) as PracticeAnswerResponse;

    expect(second.attempt.id).toBe(first.attempt.id);
    // 「次はいつ来るか」は1回目と同じものを出す。応答だけ落ちた場合、生徒が
    // 見るのはこの画面だけなので、空を返すとどこにも出なくなる。
    expect(second.next_schedule).toEqual(first.next_schedule);
    expect(services.repository.practiceAttempts).toHaveLength(1);
    expect(services.repository.practiceSchedules).toHaveLength(3);
    expect(services.scheduler.scheduledPractice).toHaveLength(3);
    // 2度目は採点器も叩かない(LLMの費用と、判定が揺れる余地の両方を断つ)。
    expect(services.grader.graded).toHaveLength(1);
  });

  /**
   * 不正解・判定できずの問題はキューに残り続ける。後日もう一度同じ答えを書くのは
   * **本物の再挑戦**なので、そちらは段を積むのが正しい。
   */
  it("窓を過ぎた同じこたえは、本物の再挑戦として段を積む", async () => {
    const problem = await seedPracticeProblem();
    await seedPracticeAttempt(problem.id, {
      id: "att_old",
      // 既定の `now` は 2026-08-03T13:24:07Z。前日の解答は窓の外。
      answered_at: "2026-08-02T11:00:00.000Z",
      response: "2個だと思う",
      verdict: "incorrect",
    });
    services.grader.set({ verdict: "incorrect", comment: "おしい", gradedBy: "stub" });

    const response = await answerPractice(problem.id, { response: "2個だと思う" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PracticeAnswerResponse;

    expect(body.attempt.id).not.toBe("att_old");
    expect(body.next_schedule.map((entry) => entry.days)).toEqual([1, 3, 7]);
    expect(services.repository.practiceAttempts).toHaveLength(2);
  });

  it("他人の問題には触れず404を返す", async () => {
    const problem = await seedPracticeProblem();
    const response = await answerPractice(
      problem.id,
      { response: "答え" },
      "11111111-2222-3333-4444-555555555555",
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "practice_not_found",
    );
    expect(services.repository.practiceAttempts).toEqual([]);
    expect(services.grader.graded).toEqual([]);
  });

  it("スキーマに合わない本文は400", async () => {
    const problem = await seedPracticeProblem();
    expect((await answerPractice(problem.id, { response: "" })).status).toBe(400);
  });
});

describe("GET /v1/me/reviews", () => {
  it("無料ユーザーにも復習キューを返し、授業可否は混ぜない", async () => {
    await seedHole();
    const response = await get("/v1/me/reviews");
    expect(response.status).toBe(200);

    const body = (await response.json()) as ReviewQueueResponse;
    expect(reviewQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body).not.toHaveProperty("lesson_requires_premium");
    expect(body).not.toHaveProperty("lesson_allowed_today");
  });

  it("穴と先輩の一言を返す", async () => {
    await seedHole();

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.days_since).toBe(3);
    expect(body.items[0]?.prompt).toBe(
      "3日前の「平方完成を「なぜ」するのか」、いまなら説明できますか?",
    );
  });

  it("出題が無い旧データではdescをquizとして返す", async () => {
    const hole = await seedHole({ quiz: null });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items[0]?.quiz).toBe(hole.desc);
  });

  it("保存済みの出題があればquizをそのまま返す", async () => {
    await seedHole({ quiz: "平方完成をする理由を説明できる?" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items[0]?.quiz).toBe("平方完成をする理由を説明できる?");
  });

  it("埋まった穴は「埋めにいく穴」には出さず、「埋めた穴」に回す", async () => {
    await makePremium();
    await seedHole({ status: "filled", filled_at: "2026-08-01T11:00:00.000Z" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(reviewQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body.items).toEqual([]);
    expect(body.filled).toHaveLength(1);
    expect(body.filled[0]?.hole.id).toBe("hol_seed");
    expect(body.filled[0]?.days_since_filled).toBe(2);
  });

  it("埋めた穴は、埋めたばかりのものを上に並べる", async () => {
    await makePremium();
    await seedHole({ status: "filled", filled_at: "2026-07-31T11:00:00.000Z" });
    await services.repository.insertKarte(
      {
        id: "kar_3",
        session_id: "ses_3",
        device_id: testDeviceId,
        created_at: "2026-08-02T11:00:00.000Z",
        topic_ids: ["M1-NIJI-HANBETSU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_3",
          device_id: testDeviceId,
          karte_id: "kar_3",
          topic_id: "M1-NIJI-HANBETSU",
          desc: "判別式の意味で説明が止まった",
          severity: "medium",
          evidence: null,
          quiz: null,
          status: "filled",
          created_at: "2026-08-02T11:00:00.000Z",
          filled_at: "2026-08-02T11:30:00.000Z",
        },
      ],
    );

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.filled.map((it) => it.hole.id)).toEqual(["hol_3", "hol_seed"]);
  });

  it("無料ユーザーにも埋めた穴を返す", async () => {
    await seedHole({ status: "filled", filled_at: "2026-08-01T11:00:00.000Z" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.filled).toHaveLength(1);
  });

  it("古い穴から順に並べる", async () => {
    await makePremium();
    await seedHole();
    await services.repository.insertKarte(
      {
        id: "kar_2",
        session_id: "ses_2",
        device_id: testDeviceId,
        created_at: "2026-08-02T11:00:00.000Z",
        topic_ids: ["M1-NIJI-HANBETSU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_2",
          device_id: testDeviceId,
          karte_id: "kar_2",
          topic_id: "M1-NIJI-HANBETSU",
          desc: "判別式の意味で説明が止まった",
          severity: "medium",
          evidence: null,
          quiz: null,
          status: "open",
          created_at: "2026-08-02T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items.map((item) => item.hole.id)).toEqual(["hol_seed", "hol_2"]);
  });
});

describe("POST /v1/me/reviews/{holeId}", () => {
  async function seedSchedules(holeId: string): Promise<void> {
    await services.repository.insertReviewSchedules([
      {
        id: "rev_seed_1",
        hole_id: holeId,
        step: 1,
        scheduled_at: "2026-08-04T11:00:00.000Z",
        external_id: "os_seed_1",
      },
      {
        id: "rev_seed_2",
        hole_id: holeId,
        step: 2,
        scheduled_at: "2026-08-06T11:00:00.000Z",
        external_id: "os_seed_2",
      },
      {
        id: "rev_seed_3",
        hole_id: holeId,
        step: 3,
        scheduled_at: "2026-08-10T11:00:00.000Z",
        external_id: "os_seed_3",
      },
    ]);
  }

  it('"said_it" で穴が埋まり、進捗をその場で返す', async () => {
    const hole = await seedHole();
    const response = await answerReview(hole.id, { outcome: "said_it" });
    expect(response.status).toBe(200);

    const body = (await response.json()) as ReviewAnswerResponse;
    expect(reviewAnswerResponseSchema.safeParse(body).success).toBe(true);
    expect(body.hole.status).toBe("filled");
    expect(body.hole.filled_at).toBe("2026-08-03T13:24:07.000Z");
    expect(body.progress.filled_holes).toBe(1);
    expect(body.progress.open_holes).toBe(0);
  });

  it('"said_it" で残りの復習通知を取り消す', async () => {
    const hole = await seedHole();
    await seedSchedules(hole.id);

    await answerReview(hole.id, { outcome: "said_it" });

    expect(services.repository.schedules).toEqual([]);
    expect(services.scheduler.cancelled).toEqual(["os_seed_1", "os_seed_2", "os_seed_3"]);
  });

  it('"not_yet" では穴も通知もそのまま残す', async () => {
    const hole = await seedHole();
    await seedSchedules(hole.id);

    const response = await answerReview(hole.id, { outcome: "not_yet" });
    const body = (await response.json()) as ReviewAnswerResponse;

    expect(body.hole.status).toBe("open");
    expect(body.progress.filled_holes).toBe(0);
    expect(body.progress.open_holes).toBe(1);
    expect(services.repository.schedules).toHaveLength(3);
    expect(services.scheduler.cancelled).toEqual([]);
  });

  it("他人の穴には触れず404を返す", async () => {
    const hole = await seedHole();
    const response = await answerReview(
      hole.id,
      { outcome: "said_it" },
      "11111111-2222-3333-4444-555555555555",
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "hole_not_found",
    );
    expect((await services.repository.getHole(hole.id))?.status).toBe("open");
  });

  it('"said_it" を2度送っても埋めた穴を二重に数えない', async () => {
    const hole = await seedHole();
    await seedSchedules(hole.id);

    await answerReview(hole.id, { outcome: "said_it" });
    const second = await answerReview(hole.id, { outcome: "said_it" });
    const body = (await second.json()) as ReviewAnswerResponse;

    expect(body.progress.filled_holes).toBe(1);
    expect(services.scheduler.cancelled).toEqual(["os_seed_1", "os_seed_2", "os_seed_3"]);
  });

  it("スキーマに合わない本文は400", async () => {
    const hole = await seedHole();
    expect((await answerReview(hole.id, { outcome: "almost" })).status).toBe(400);
  });
});

// 復習画面の一行も、穴と同じ課程の言語で出す(通知文と同じ文面)。
describe("復習キューの言語", () => {
  it("英語の課程の穴には英語の一行を返す", async () => {
    await makePremium();
    await seedHole({
      topic_id: "A1-QUAD-SOLVE",
      desc: "the explanation stopped at why the discriminant is used",
    });

    const response = await get("/v1/me/reviews");
    const body = (await response.json()) as ReviewQueueResponse;

    expect(reviewQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body.items[0]?.prompt).toBe(
      'That "why the discriminant is used" from 3 days ago — could you explain it to me now?',
    );
  });

  it("日本の課程の穴は日本語のまま", async () => {
    await makePremium();
    await seedHole();

    const response = await get("/v1/me/reviews");
    const body = (await response.json()) as ReviewQueueResponse;
    expect(body.items[0]?.prompt).toContain("いまなら説明できますか?");
  });
});

async function seedReportProblem(input: {
  id: string;
  localDate: string;
  createdAt: string;
  topicId: string;
  attempts?: {
    id: string;
    answeredAt: string;
    response: string;
    verdict: PracticeAttemptRecord["verdict"];
  }[];
}): Promise<void> {
  const sessionId = `ses_${input.id}`;
  const created = await services.repository.createSession({
    session: sessionRow(sessionId, {
      status: "completed",
      created_at: input.createdAt,
      completed_at: input.createdAt,
      local_date: input.localDate,
      topic_ids: [input.topicId],
      practice_problem_id: input.id,
      duration_seconds: 900,
      started_at: input.createdAt,
    }),
    // これは原価上限のテストではなく、月次集計の履歴を作る足場。
    maxAnalysesPerDay: 99,
  });
  if (!created) throw new Error("親レポート用セッションを作れませんでした");

  await services.repository.insertPracticeProblem({
    id: input.id,
    session_id: sessionId,
    device_id: testDeviceId,
    board_id: `brd_${input.id}`,
    created_at: input.createdAt,
    topic_id: input.topicId,
    question: `親レポートには混ぜない問題文_${input.id}`,
    answer: `生徒へ返さない正解_${input.id}`,
  });
  for (const attempt of input.attempts ?? []) {
    await services.repository.insertPracticeAttempt({
      id: attempt.id,
      problem_id: input.id,
      answered_at: attempt.answeredAt,
      response: attempt.response,
      verdict: attempt.verdict,
      graded_by: "stub",
      comment: "いいね",
    });
  }
}

describe("GET /v1/me/parent-report", () => {
  it("無料ユーザーには本文を漏らさず、ロック状態を200で返す", async () => {
    const response = await get("/v1/me/parent-report");
    expect(response.status).toBe(200);

    const body = (await response.json()) as ParentReportResponse;
    expect(parentReportResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ requires_premium: true, report: null });
  });

  it("Premiumには今月の実績と本人の言葉だけを返す", async () => {
    await makePremium();

    await seedReportProblem({
      id: "prb_july",
      localDate: "2026-07-31",
      createdAt: "2026-07-31T11:00:00.000Z",
      topicId: "M1-NIJI-GURAFU",
      attempts: [
        {
          id: "att_july",
          answeredAt: "2026-07-31T12:00:00.000Z",
          response: "先月の説明は今月へ混ぜない",
          verdict: "correct",
        },
      ],
    });
    await seedReportProblem({
      id: "prb_august_1",
      localDate: "2026-08-01",
      createdAt: "2026-08-01T11:00:00.000Z",
      topicId: "M1-NIJI-GURAFU",
      attempts: [
        {
          id: "att_august_1",
          answeredAt: "2026-08-01T12:00:00.000Z",
          response: "不正解の説明は親へ見せない",
          verdict: "incorrect",
        },
      ],
    });
    await seedReportProblem({
      id: "prb_august_2",
      localDate: "2026-08-02",
      createdAt: "2026-08-02T11:00:00.000Z",
      topicId: "M2-ZUKEI-ENCHOKU",
      attempts: [
        {
          id: "att_august_2_old",
          answeredAt: "2026-08-02T11:30:00.000Z",
          response: "古い4件目",
          verdict: "correct",
        },
        {
          id: "att_august_2",
          answeredAt: "2026-08-02T12:00:00.000Z",
          response: "距離と半径を比べれば交点の個数がわかります",
          verdict: "correct",
        },
      ],
    });
    await seedReportProblem({
      id: "prb_august_3",
      localDate: "2026-08-03",
      createdAt: "2026-08-03T11:00:00.000Z",
      topicId: "M1-NIJI-HANBETSU",
      attempts: [
        {
          id: "att_august_3_same",
          answeredAt: "2026-08-03T12:59:00.000Z",
          response: "同じ説明",
          verdict: "correct",
        },
        {
          id: "att_august_3",
          answeredAt: "2026-08-03T13:00:00.000Z",
          response: "判別式は実数解の個数を調べるものです",
          verdict: "correct",
        },
        {
          id: "att_august_3_incorrect",
          answeredAt: "2026-08-03T13:01:00.000Z",
          response: "直近でも不正解の説明は親へ見せない",
          verdict: "incorrect",
        },
      ],
    });
    // 移行前の穴が残っていても、解けた問題数へ足すと同じ成果を二重に数える。
    await seedHole({
      id: "hol_august",
      topic_id: "M1-NIJI-HANBETSU",
      status: "filled",
      filled_at: "2026-08-02T12:00:00.000Z",
    });

    const response = await get("/v1/me/parent-report");
    const body = (await response.json()) as ParentReportResponse;
    expect(parentReportResponseSchema.safeParse(body).success).toBe(true);
    expect(body.requires_premium).toBe(false);
    if (body.requires_premium) throw new Error("Premiumの親レポートがロックされています");

    expect(body.report.period).toEqual({ start_date: "2026-08-01", end_date: "2026-08-03" });
    expect(body.report.filled_holes).toBe(2);
    expect(body.report.streak_days).toBe(4);
    expect(body.report.explained_topics).toEqual([
      { topic_id: "M1-NIJI-HANBETSU", name: "二次方程式の判別式と実数解の個数" },
      { topic_id: "M2-ZUKEI-ENCHOKU", name: "円と直線の位置関係" },
    ]);
    expect(body.report.quotes).toEqual([
      "判別式は実数解の個数を調べるものです",
      "同じ説明",
      "距離と半径を比べれば交点の個数がわかります",
    ]);
    expect(body.report.quotes).toHaveLength(parentReportQuoteMaxCount);
    expect(body.report.quotes).not.toContain("先月の説明は今月へ混ぜない");
    expect(body.report.quotes).not.toContain("直近でも不正解の説明は親へ見せない");
    expect(JSON.stringify(body.report)).not.toContain("親レポートには混ぜない問題文");
    expect(JSON.stringify(body.report)).not.toContain("生徒へ返さない正解");
    expect(Object.keys(body.report)).not.toContain("accuracy");
  });

  /** 正解がまだ無い月でもレポートを開けないと、親には課金画面の故障に見える。 */
  it("正解した解答が0件でもquotesを空配列で返す", async () => {
    await makePremium();
    await seedReportProblem({
      id: "prb_unclear",
      localDate: "2026-08-03",
      createdAt: "2026-08-03T11:00:00.000Z",
      topicId: "M1-NIJI-HANBETSU",
      attempts: [
        {
          id: "att_unclear",
          answeredAt: "2026-08-03T12:00:00.000Z",
          response: "判定できなかった答え",
          verdict: "unclear",
        },
      ],
    });

    const body = (await (await get("/v1/me/parent-report")).json()) as ParentReportResponse;
    expect(parentReportResponseSchema.safeParse(body).success).toBe(true);
    expect(body.requires_premium).toBe(false);
    if (body.requires_premium) throw new Error("Premiumの親レポートがロックされています");
    expect(body.report.quotes).toEqual([]);
  });

  it("デバイスIDがなければ401", async () => {
    expect((await app.request("/v1/me/parent-report", {}, bindings)).status).toBe(401);
  });
});
