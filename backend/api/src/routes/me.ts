import {
  type Hole,
  type ParentReportResponse,
  type PracticeAnswerResponse,
  type PracticeQueueItem,
  type PracticeQueueResponse,
  type PracticeVerdict,
  type ProgressResponse,
  type ReviewAnswerResponse,
  type ReviewQueueResponse,
  filledHolesLimit,
  parentReportQuoteMaxCount,
  parentReportQuoteMaxLength,
  parentReportTopicMaxCount,
  practiceAnswerRequestSchema,
  reviewAnswerRequestSchema,
  solvedPracticeLimit,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import {
  buildReviewPrompt,
  computeParentReport,
  computeProgress,
  daysBetween,
  practiceStepsByVerdict,
  schedulePractice,
  toLocalDate,
} from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { readLimits } from "../env.ts";
import {
  canStartSessionToday,
  hasPremiumAccess,
  secondsPerDay,
  sessionMaxSeconds,
  tokenGraceSeconds,
} from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import type {
  HoleRecord,
  PracticeAttemptRecord,
  PracticeScheduleRecord,
} from "../repository/types.ts";
import { toPracticeProblem, topicLabelOf } from "./complete.ts";

export const meRoute = new Hono<AppEnv>();

/**
 * 同じこたえの送り直しを「1回目の続き」として扱う幅。
 *
 * 通信の失敗と押し直しに要る時間だけを見込む。長くすると、**本物の再挑戦**
 * (不正解の問題に後からもう一度同じ答えを書く)まで飲み込んで段が積まれなくなる。
 */
const practiceResendWindowMs = 5 * 60 * 1000;

/** GET /v1/me/progress — ホーム画面のカウンター。 */
meRoute.get("/progress", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");
  const limits = readLimits(c.env);

  const user = await repository.ensureUser(deviceId, at);
  const premium = hasPremiumAccess({ user, now: at, limits });
  const localDate = toLocalDate(at);

  // /complete が来ない回も、トークンの寿命を過ぎたら仮押さえ額で精算する。
  await repository.settleExpiredSessions({
    deviceId,
    now: at.toISOString(),
    graceSeconds: tokenGraceSeconds,
  });
  const [sessionDates, holes, problems, attempts, usage] = await Promise.all([
    repository.sessionDates(deviceId),
    // 穴は移行期のあいだだけ読む。カウンターの正は復習問題側へ移った(ADR 0009)。
    repository.listHoles(deviceId),
    repository.listPracticeProblems(deviceId),
    repository.listPracticeAttempts(deviceId),
    repository.getDailySessionUsage(deviceId, localDate),
  ]);
  const remainingSecondsToday = Math.max(
    0,
    secondsPerDay({ user, now: at, limits }) - usage.consumedSeconds,
  );

  const response: ProgressResponse = {
    progress: computeProgress({ sessionDates, holes, problems, attempts, today: localDate }),
    is_premium: premium,
    limits: {
      max_seconds: sessionMaxSeconds({ user, now: at, limits }),
      remaining_seconds_today: remainingSecondsToday,
      lesson_allowed_today: canStartSessionToday({
        remainingSecondsToday,
        sessionsToday: usage.sessionsStarted,
      }),
    },
  };
  return c.json(response);
});

/**
 * GET /v1/me/practice — 復習画面(プッシュ起点)。
 *
 * 返すのは2つ。「解きにいく問題」(未解答・不正解・判定できず)と
 * 「解けた問題」。並び順の思想は穴のキューから引き継ぐ —
 * **古い順。放置されたものから声をかける。**穴の `severity` に相当する軸は
 * 復習問題に無いので、二番目の鍵は持たない。
 */
meRoute.get("/practice", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");
  const today = toLocalDate(at);

  const [problems, attempts] = await Promise.all([
    repository.listPracticeProblems(deviceId),
    repository.listPracticeAttempts(deviceId),
  ]);

  const history = groupAttempts(attempts);

  const items = problems
    .filter((problem) => !isSolved(history.get(problem.id)))
    .map((problem) => ({
      problem: toPracticeProblem(problem),
      days_since: daysBetween(toLocalDate(new Date(problem.created_at)), today),
      topic_label: topicLabelOf(problem.topic_id),
      last_verdict: lastVerdictOf(history.get(problem.id)),
    }))
    // 古い問題を上に。放置されたものから声をかける。
    .sort((a, b) => b.days_since - a.days_since);

  const solved = problems
    .flatMap((problem) => {
      const solvedAt = firstCorrectAt(history.get(problem.id));
      if (solvedAt === null) return [];
      return [
        {
          problem: toPracticeProblem(problem),
          topic_label: topicLabelOf(problem.topic_id),
          days_since_solved: daysBetween(toLocalDate(new Date(solvedAt)), today),
        },
      ];
    })
    // 解けたばかりのものを上に。積み上がった手応えが先に目に入るように。
    .sort((a, b) => a.days_since_solved - b.days_since_solved)
    // 通算の件数はホームの `solved_problems` のほうが正。ここは画面に出すぶんだけ。
    .slice(0, solvedPracticeLimit);

  const response: PracticeQueueResponse = { items, solved };
  return c.json(response);
});

/**
 * GET /v1/me/practice/{problemId} — 1問だけを引く。**通知の着地点。**
 *
 * リスト(`GET /v1/me/practice`)から探させない理由が2つある:
 *
 *   1. **正解した問題にも通知は届く。**正解は 3日後・7日後 の2本で、
 *      1本目に正解しても2本目は取り消さない(ADR 0009)。その通知をタップした先は
 *      `items` に無い(解けた問題は `solved` へ回っている)
 *   2. `solved` は直近 {@link solvedPracticeLimit} 件までしか載らない。
 *      よく解く生徒ほど、古い問題の7日後の通知が**どちらのリストにも無い**状態になる
 *
 * つまりリストは「いま何があるか」を出す面で、通知の宛先の解決には使えない。
 */
meRoute.get("/practice/:problemId", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const problem = await repository.getPracticeProblem(c.req.param("problemId"));
  // 存在の有無と所有者の違いを同じ404にして、他人の問題を触らせず、存在も漏らさない。
  if (!problem || problem.device_id !== deviceId) throw apiError("practice_not_found");

  const attempts = (await repository.listPracticeAttempts(deviceId)).filter(
    (attempt) => attempt.problem_id === problem.id,
  );

  const response: PracticeQueueItem = {
    problem: toPracticeProblem(problem),
    days_since: daysBetween(toLocalDate(new Date(problem.created_at)), toLocalDate(at)),
    topic_label: topicLabelOf(problem.topic_id),
    last_verdict: lastVerdictOf(attempts),
  };
  return c.json(response);
});

/**
 * POST /v1/me/practice/{problemId} — テキストの解答を採点する。
 *
 * **合否に関わらず履歴に積む。**変わるのは次の通知の段だけ:
 * 不正解 = 1・3・7日 / 正解 = 3・7日 / 判定できず = 予約しない。
 *
 * **作成時に決めた段は取り消さない**(ADR 0009)。「3日目に正解したから
 * 7日目を消す」をやると「1回言えたら終わり」に戻り、間隔反復の効き目が消える。
 * だから、ここは**足すだけ**でキャンセルの経路を持たない。
 */
meRoute.post("/practice/:problemId", async (c) => {
  const { repository, grader, scheduler, now, newId } = c.get("services");
  const log = c.get("log");
  const at = now();
  const deviceId = c.get("deviceId");

  const parsed = practiceAnswerRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "こたえを読み取れませんでした。もう一度おくってみてください。",
        },
      },
      400,
    );
  }

  const problem = await repository.getPracticeProblem(c.req.param("problemId"));
  // 存在の有無と所有者の違いを同じ404にして、他人の問題を触らせず、存在も漏らさない。
  if (!problem || problem.device_id !== deviceId) throw apiError("practice_not_found");

  /**
   * **同じこたえの送り直しを、2度目の採点にしない。**
   *
   * この POST がタイムアウトしても、アプリは下書きを消さない
   * (`PracticeAnswerController.submit` の catch)。生徒がもう一度押すと
   * **一字一句同じ本文**が届く。素通しすると採点履歴が二重に積まれ、
   * 1・3・7日(正解なら3・7日)の段がもう一組予約されて、**同じ問題の通知が
   * 2回届く**。`idx_practice_problems_session` と同じ天秤で、取りこぼしより
   * 二重通知のほうが痛い。
   *
   * **窓で切る。**同じ答えを後日もう一度書くのは本物の再挑戦
   * (不正解・判定できずの問題はキューに残り続ける)で、そちらは段を積むのが正しい。
   * 通信の送り直しは数秒〜数十秒で起きるので、その幅だけを拾う。
   */
  const known = await repository.listPracticeAttempts(deviceId);
  const previous = known.filter((entry) => entry.problem_id === problem.id).at(-1);
  if (
    previous &&
    previous.response === parsed.data.response &&
    at.getTime() - Date.parse(previous.answered_at) < practiceResendWindowMs
  ) {
    log?.info("practice_answer_resent", {
      problem_id: problem.id,
      attempt_id: previous.id,
      verdict: previous.verdict,
    });
    const [sessionDates, problems] = await Promise.all([
      repository.sessionDates(deviceId),
      repository.listPracticeProblems(deviceId),
    ]);
    const replayed: PracticeAnswerResponse = {
      attempt: previous,
      // **1回目に予約した段をそのまま組み直す。**新しく予約はしない。
      // 応答だけ落ちた場合、生徒が見るのはこの2回目の画面だけなので、
      // 空を返すと「次はいつ来るか」がどこにも出なくなる。
      next_schedule: schedulePractice(
        [problem.id],
        new Date(previous.answered_at),
        practiceStepsByVerdict[previous.verdict],
      ),
      progress: computeProgress({
        sessionDates,
        problems,
        attempts: known,
        today: toLocalDate(at),
      }),
    };
    return c.json(replayed);
  }

  const locale = localeOfTopicId(problem.topic_id);
  const grading = await grader.grade({
    question: problem.question,
    answer: problem.answer,
    response: parsed.data.response,
    locale,
  });

  const attempt: PracticeAttemptRecord = {
    id: newId("att"),
    problem_id: problem.id,
    answered_at: at.toISOString(),
    response: parsed.data.response,
    verdict: grading.verdict,
    graded_by: grading.gradedBy,
    comment: grading.comment,
  };
  await repository.insertPracticeAttempt(attempt);

  const steps = practiceStepsByVerdict[grading.verdict];
  const nextSchedule = schedulePractice([problem.id], at, steps);
  const persisted: PracticeScheduleRecord[] = [];
  for (const entry of nextSchedule) {
    let externalId: string | null = null;
    try {
      const scheduled = await scheduler.schedulePractice({
        deviceId,
        problemId: problem.id,
        step: entry.step as 1 | 2 | 3,
        sendAt: entry.scheduled_at,
        topicLabel: topicLabelOf(problem.topic_id),
        daysSince: entry.days,
        locale,
      });
      externalId = scheduled.externalId;
    } catch (error) {
      // 通知の予約に失敗しても、採点結果は返す。プッシュのために体験を止めない。
      log?.error("practice_schedule_failed", error, { problem_id: problem.id });
    }
    persisted.push({
      id: newId("psc"),
      problem_id: problem.id,
      step: entry.step as 1 | 2 | 3,
      scheduled_at: entry.scheduled_at,
      external_id: externalId,
    });
  }
  await repository.insertPracticeSchedules(persisted);

  const [sessionDates, problems, attempts] = await Promise.all([
    repository.sessionDates(deviceId),
    repository.listPracticeProblems(deviceId),
    repository.listPracticeAttempts(deviceId),
  ]);

  log?.info("practice_graded", {
    problem_id: problem.id,
    verdict: grading.verdict,
    graded_by: grading.gradedBy,
    scheduled: persisted.length,
  });

  const response: PracticeAnswerResponse = {
    attempt,
    next_schedule: nextSchedule,
    progress: computeProgress({ sessionDates, problems, attempts, today: toLocalDate(at) }),
  };
  return c.json(response);
});

/**
 * GET /v1/me/reviews — 穴ベースの復習画面。
 *
 * @deprecated ADR 0009。復習問題へ移った(`GET /v1/me/practice`)。
 * 旧アプリが読みに来る窓が閉じるまで残す。**新しい穴はもう作られない**ので、
 * ここが返すのは移行前に溜まった分だけで、いずれ空になる。
 */
meRoute.get("/reviews", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const today = toLocalDate(at);
  const holes = await repository.listHoles(deviceId);
  const items = holes
    .filter((hole) => hole.status === "open")
    .map((hole) => {
      const daysSince = daysBetween(toLocalDate(new Date(hole.created_at)), today);
      return {
        hole: toHole(hole),
        topic_id: hole.topic_id,
        days_since: daysSince,
        // 復習画面の一行も、穴と同じ課程の言語で出す(通知文と同じ文面)。
        prompt: buildReviewPrompt({
          desc: hole.desc,
          daysSince,
          locale: localeOfTopicId(hole.topic_id),
        }),
        // 旧データには出題が無い。クライアントに分岐を持たせると画面ごとに違う問いが出る。
        quiz: hole.quiz ?? hole.desc,
      };
    })
    // 古い穴 → 深い穴の順。放置されたものから声をかける。
    .sort(
      (a, b) =>
        b.days_since - a.days_since ||
        severityRank(b.hole.severity) - severityRank(a.hole.severity),
    );

  const filled = holes
    .filter((hole) => hole.status === "filled" && hole.filled_at !== null)
    .map((hole) => ({
      hole: toHole(hole),
      topic_id: hole.topic_id,
      days_since_filled: daysBetween(toLocalDate(new Date(hole.filled_at as string)), today),
    }))
    // 埋めたばかりのものを上に。積み上がった手応えが先に目に入るように。
    .sort((a, b) => a.days_since_filled - b.days_since_filled)
    .slice(0, filledHolesLimit);

  const response: ReviewQueueResponse = {
    items,
    filled,
  };
  return c.json(response);
});

/**
 * GET /v1/me/parent-report — 今月の学習を、親へ見せられる形にする。
 *
 * 親レポートはPremiumだが、無料ユーザーを402にはしない。復習と同じく
 * 「まだ開いていない」状態を200で返すと、アプリは失敗画面ではなく
 * 課金導線として扱える。ロック中は本文を返さず、契約の判別共用体でも漏れを防ぐ。
 *
 * 引用の出どころは**復習問題への解答のうち `correct` のものだけ**(ADR 0009)。
 * カルテの `said_well` から替えた理由は `computeParentReport` に書いてある。
 */
meRoute.get("/parent-report", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const user = await repository.ensureUser(deviceId, at);
  if (!hasPremiumAccess({ user, now: at, limits: readLimits(c.env) })) {
    const locked: ParentReportResponse = { requires_premium: true, report: null };
    return c.json(locked);
  }

  const today = toLocalDate(at);
  // 期間の絞り込みは `computeParentReport` が持つ(月境界の判断を2か所に置かない)。
  const [sessionDates, holes, problems, attempts] = await Promise.all([
    repository.sessionDates(deviceId),
    repository.listHoles(deviceId),
    repository.listPracticeProblems(deviceId),
    repository.listPracticeAttempts(deviceId),
  ]);

  const response: ParentReportResponse = {
    requires_premium: false,
    report: computeParentReport({
      today,
      sessionDates,
      holes,
      problems,
      attempts,
      limits: {
        quoteCount: parentReportQuoteMaxCount,
        quoteLength: parentReportQuoteMaxLength,
        topicCount: parentReportTopicMaxCount,
      },
    }),
  };
  return c.json(response);
});

/**
 * POST /v1/me/reviews/{holeId} — 10秒小テストの自己申告。
 *
 * @deprecated ADR 0009。採点は `POST /v1/me/practice/{problemId}` が持つ。
 * 移行前に溜まった穴のためだけに残す。
 */
meRoute.post("/reviews/:holeId", async (c) => {
  const { repository, scheduler, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const parsed = reviewAnswerRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "回答を読み取れませんでした。もう一度選んでみてください。",
        },
      },
      400,
    );
  }

  const hole = await repository.getHole(c.req.param("holeId"));
  // 存在の有無と所有者の違いを同じ404にして、他人の穴を触らせず、存在も漏らさない。
  if (!hole || hole.device_id !== deviceId) throw apiError("hole_not_found");

  // openのときだけ動かすことで、「言えた」の再送でも二重に数えず、通知も再取消ししない。
  if (parsed.data.outcome === "said_it" && hole.status === "open") {
    await repository.markHoleFilled(hole.id, at.toISOString());
    const cancelled = await repository.cancelReviewSchedules(hole.id);
    for (const entry of cancelled) {
      if (entry.external_id) await scheduler.cancel(entry.external_id);
    }
  }

  // `not_yet` では上の保存処理を一切通らない。openの穴と通知をそのまま残す。
  const [sessionDates, holes, problems, attempts] = await Promise.all([
    repository.sessionDates(deviceId),
    repository.listHoles(deviceId),
    repository.listPracticeProblems(deviceId),
    repository.listPracticeAttempts(deviceId),
  ]);
  const currentHole = holes.find((candidate) => candidate.id === hole.id);
  if (!currentHole) throw apiError("hole_not_found");

  const response: ReviewAnswerResponse = {
    hole: toHole(currentHole),
    progress: computeProgress({ sessionDates, holes, problems, attempts, today: toLocalDate(at) }),
  };
  return c.json(response);
});

/** 問題ID → その問題への解答(古い順)。 */
function groupAttempts(
  attempts: readonly PracticeAttemptRecord[],
): Map<string, PracticeAttemptRecord[]> {
  const byProblem = new Map<string, PracticeAttemptRecord[]>();
  for (const attempt of attempts) {
    const list = byProblem.get(attempt.problem_id);
    if (list) {
      list.push(attempt);
    } else {
      byProblem.set(attempt.problem_id, [attempt]);
    }
  }
  return byProblem;
}

/**
 * 解けた問題か。**一度でも正解していれば解けた扱い。**
 *
 * 「最後の解答が正解か」で見ない。3日後に正解して7日後に間違えた問題を
 * 「まだ解けていない」に戻すと、積み上がった手応え(`solved`)が減る —
 * 数えているのは努力なので、減る数字にしない。
 */
function isSolved(attempts: readonly PracticeAttemptRecord[] | undefined): boolean {
  return firstCorrectAt(attempts) !== null;
}

function firstCorrectAt(attempts: readonly PracticeAttemptRecord[] | undefined): string | null {
  return attempts?.find((attempt) => attempt.verdict === "correct")?.answered_at ?? null;
}

/** 直近の判定。一度も解いていなければ `null`。 */
function lastVerdictOf(
  attempts: readonly PracticeAttemptRecord[] | undefined,
): PracticeVerdict | null {
  return attempts?.at(-1)?.verdict ?? null;
}

/** D1の行 → 契約の Hole。evidence / quiz は null を持たせず、キーごと落とす。 */
function toHole(hole: HoleRecord): Hole {
  return {
    id: hole.id,
    topic_id: hole.topic_id,
    desc: hole.desc,
    severity: hole.severity,
    ...(hole.evidence ? { evidence: hole.evidence } : {}),
    ...(hole.quiz ? { quiz: hole.quiz } : {}),
    status: hole.status,
    created_at: hole.created_at,
    filled_at: hole.filled_at,
  };
}

function severityRank(severity: string): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}
