import {
  type CompleteSessionResponse,
  type PracticeProblem,
  type PracticeScheduleEntry,
  completeSessionRequestSchema,
} from "@ai-sensei/contract";
import { findTopic, localeOfTopicId } from "@ai-sensei/curriculum";
import {
  buildAllowedTopics,
  computeProgress,
  filterHoleTopicIds,
  practiceStepsOnCreate,
  schedulePractice,
  toLocalDate,
} from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv, Limits } from "../env.ts";
import { readLimits } from "../env.ts";
import {
  canStartSessionToday,
  hasPremiumAccess,
  secondsPerDay,
  sessionMaxSeconds,
  sessionStartsPerDay,
  shouldShowPaywall,
} from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import type { NotificationScheduler } from "../lib/notifications.ts";
import type { RequestLogger } from "../lib/observability.ts";
import type {
  DailySessionUsage,
  PracticeProblemRecord,
  PracticeScheduleRecord,
  Repository,
  SessionRecord,
  UserRecord,
} from "../repository/types.ts";

export const completeRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions/{id}/complete — agentが呼ぶ内部エンドポイント。
 *
 * transcriptと、**「わかった」で降りた回だけ**入っている復習問題を受け取り、
 *   1. 問題のtopic_idをこのセッションの許可リストで照合(ガードレール2枚目)
 *   2. 復習問題をD1に保存
 *   3. 3日後・7日後の通知をOneSignalに予約
 * を行う。
 *
 * **翌日(step 1)は予約しない。**「わかった」は到達の宣言なので、
 * 押した翌日に「まちがえた問題」と同じ間隔で届くと、押したことが罰になる
 * (`practiceStepsOnCreate`)。
 *
 * カルテと穴の保存はここにあった。ADR 0009 で畳んである。
 */
completeRoute.post("/:sessionId/complete", async (c) => {
  const { repository, scheduler, now, newId } = c.get("services");
  const log = c.get("log");
  const at = now();

  const authorized = c.req.header("authorization") === `Bearer ${c.env.INTERNAL_API_TOKEN}`;
  if (!authorized) {
    // agent と API で内部トークンがずれていると、会話は成立するのに復習問題だけ
    // 落ちる。生徒からは「3日後に何も来ない」としか見えないので、ここに残す。
    log?.warn("complete_unauthorized", { session_id: c.req.param("sessionId") });
    throw apiError("unauthorized");
  }

  const session = await repository.getSession(c.req.param("sessionId"));
  if (!session) throw apiError("session_not_found");

  const parsed = completeSessionRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    // 契約が壊れている。agent側のLLM出力かスキーマのずれ。
    log?.error("complete_invalid_payload", parsed.error, { session_id: session.id });
    return c.json({ error: { code: "internal_error", message: parsed.error.message } }, 400);
  }
  const body = parsed.data;

  /**
   * agentがタイムアウトで再送してくることがある。素通しすると、問題も通知予約も
   * 二重に作られる。
   *
   * **判定はセッションの `status`。**旧経路は `getKarteBySession` を鍵にしていたが、
   * カルテを畳んだので、そのままでは「問題を作らなかった回」(時間切れ・離脱)の
   * 再送を弾けなくなる — あの回は保存物が1つも無いので、保存物の有無では判定できない。
   * `completeSession` が `status` を `completed` にするので、そこを見る。
   *
   * **`status` だけでは足りない場合がひとつある。**`completeSession` は問題の保存より
   * 先に走るので、その間で落ちると「完了しているのに問題が無い」行が残る。
   * 送られてきた本文に問題が入っているなら、それは取りこぼしなので保存へ進む。
   * (同時に2本投げられた場合は `idx_practice_problems_session` の UNIQUE が2本目を落とし、
   *  その回の再送がここで replay になる。)
   */
  const alreadyStored = await repository.getPracticeProblemBySession(session.id);
  if (session.status === "completed" && (alreadyStored !== null || !body.practice_problem)) {
    /**
     * **段だけ取りこぼした回を、ここで拾い直す。**
     *
     * 保存(`insertPracticeProblem`)と予約(`insertPracticeSchedules`)は別の文で、
     * D1 は文をまたいだトランザクションを張らない。あいだで worker が落ちると
     * 「問題はあるのに段が1つも無い」行が残り、**約束した3日後・7日後が永久に来ない**。
     * 生徒からは「わかったを押したのに何も届かない」としか見えない。
     *
     * 段が0本のときだけやり直す。1本でもあれば予約は済んでいる
     * (外部IDが null の行は「予約を試みて失敗した記録」で、これは既知の縮退。
     *  ここでやり直すと、成功していた分まで二重に届く)。
     */
    let resumed: PracticeScheduleEntry[] = [];
    if (alreadyStored !== null) {
      const existing = await repository.listPracticeSchedules(alreadyStored.id);
      if (existing.length === 0) {
        resumed = schedulePractice([alreadyStored.id], at, practiceStepsOnCreate);
        await persistPracticeSchedules({
          repository,
          scheduler,
          newId,
          log,
          deviceId: session.device_id,
          problem: alreadyStored,
          entries: resumed,
        });
        log?.warn("practice_schedule_resumed", {
          session_id: session.id,
          problem_id: alreadyStored.id,
        });
      }
    }

    log?.info("complete_replayed", {
      session_id: session.id,
      practice_problem: alreadyStored !== null,
    });
    return c.json(
      await buildResponse({
        repository,
        at,
        session,
        problem: alreadyStored,
        schedule: resumed,
        limits: readLimits(c.env),
      }),
      200,
    );
  }

  const durationSeconds = Math.min(body.duration_seconds, 60 * 60);
  await repository.completeSession({
    sessionId: session.id,
    completedAt: at.toISOString(),
    durationSeconds,
  });

  const draft = body.practice_problem ?? null;
  let stored: PracticeProblemRecord | null = null;
  let scheduleEntries: PracticeScheduleEntry[] = [];

  if (draft !== null) {
    /**
     * ガードレール2枚目。範囲外の単元を問う問題を通知に載せない。
     *
     * **付け替えずに落とす。**穴は「本人が詰まった事実」だったので主単元へ
     * 付け替えて残していたが、復習問題にはその事実が無い。範囲外のIDが付いた問題は
     * 中身も範囲外である可能性が高く、付け替えると
     * **中身は範囲外のまま、タグだけ正しい問題**が3日後に届く。
     */
    const allowed = buildAllowedTopics(session.topic_ids);
    const { rejected } = filterHoleTopicIds([draft], allowed);
    const outOfScope = rejected[0];
    if (outOfScope) {
      log?.warn("practice_problem_rejected", {
        session_id: session.id,
        topic_id: draft.topic_id,
        reason: outOfScope.reason,
      });
    } else {
      const record: PracticeProblemRecord = {
        id: newId("prb"),
        device_id: session.device_id,
        session_id: session.id,
        // agent は問題を作ったときだけ `board_id` を添える。欠けているのは
        // 契約違反ではなく古いagentなので、追跡を諦めて保存は通す。
        board_id: body.board_id ?? "",
        topic_id: draft.topic_id,
        question: draft.question,
        answer: draft.answer,
        created_at: at.toISOString(),
      };
      await repository.insertPracticeProblem(record);
      stored = record;

      scheduleEntries = schedulePractice([record.id], at, practiceStepsOnCreate);
      await persistPracticeSchedules({
        repository,
        scheduler,
        newId,
        log,
        deviceId: session.device_id,
        problem: record,
        entries: scheduleEntries,
      });
    }
  }

  const user = await repository.getUser(session.device_id);
  const currentLimits = readLimits(c.env);
  const premium = hasPremiumAccess({ user, now: at, limits: currentLimits });

  const localDate = toLocalDate(at);
  const [sessionDates, problems, attempts, usage] = await Promise.all([
    repository.sessionDates(session.device_id),
    repository.listPracticeProblems(session.device_id),
    repository.listPracticeAttempts(session.device_id),
    repository.getDailySessionUsage(session.device_id, localDate),
  ]);

  const sessionLimits = sessionLimitsPayload({ user, usage, at, limits: currentLimits });
  const response: CompleteSessionResponse = {
    practice_problem: stored === null ? null : toPracticeProblem(stored),
    practice_schedule: scheduleEntries,
    progress: computeProgress({ sessionDates, problems, attempts, today: localDate }),
    limits: sessionLimits,
    // 無料で今日の1回を使い切った回に出す。判定に使うのは、いま返した残高と
    // **同じもの**にする(画面が「今日はここまで」と言っている横で、
    // ペイウォールだけが別の残高を見ている状態を作らない)。
    show_paywall: shouldShowPaywall({
      isPremium: premium,
      lessonAllowedToday: sessionLimits.lesson_allowed_today,
    }),
  };

  // 会話が成立したかどうかと、復習問題ができたかが、この1行で分かる。
  log?.info("session_completed", {
    session_id: session.id,
    kind: session.kind,
    ended_reason: body.ended_reason,
    duration_seconds: durationSeconds,
    transcript_turns: body.transcript.length,
    practice_problem: stored !== null,
    scheduled: scheduleEntries.length,
  });

  return c.json(response, 201);
});

/** D1の行 → 契約の PracticeProblem。**`answer` は落とす**(生徒には返さない)。 */
export function toPracticeProblem(problem: PracticeProblemRecord): PracticeProblem {
  return {
    id: problem.id,
    session_id: problem.session_id,
    board_id: problem.board_id,
    topic_id: problem.topic_id,
    question: problem.question,
    created_at: problem.created_at,
  };
}

/**
 * 画面のヘッダに出す単元名。
 *
 * カリキュラムに無いIDは、そのままIDを出す。空文字にすると
 * `topic_label` の `.min(1)` で応答ごと落ち、**問題は保存できているのに
 * 復習リストが開かない**という壊れ方になる。
 */
export function topicLabelOf(topicId: string): string {
  return findTopic(topicId)?.topic ?? topicId;
}

/**
 * 保存済みの状態からレスポンスを組み立て直す。
 *
 * - agentからの再送(`/complete` が二度呼ばれた場合)
 * - アプリからの結果取得(`GET /v1/sessions/{id}/result`)
 *
 * の両方で使う。**`practice_schedule` は空で返す。**再送で予約を作り直さないのと
 * 同じ理由で、既に予約したものをもう一度「いま予約した」として返さない
 * (祝福画面が「3日後に送るね」を二度言うことになる)。
 */
/**
 * 段を予約して、予約した事実を行として残す。
 *
 * **外部の予約に失敗しても行は残す。** 外部IDが null の行は「予約を試みて失敗した」
 * 記録で、これを残さないと再送のたびに全段を予約し直して二重に届く
 * (`idx_practice_problems_session` のコメントと同じ天秤 —
 *  取りこぼしより二重通知のほうが痛い)。
 */
async function persistPracticeSchedules(input: {
  repository: Repository;
  scheduler: NotificationScheduler;
  newId: (prefix: string) => string;
  log: RequestLogger | undefined;
  deviceId: string;
  problem: PracticeProblemRecord;
  entries: PracticeScheduleEntry[];
}): Promise<void> {
  const { repository, scheduler, newId, log, deviceId, problem, entries } = input;
  const persisted: PracticeScheduleRecord[] = [];

  for (const entry of entries) {
    let externalId: string | null = null;
    try {
      const scheduled = await scheduler.schedulePractice({
        deviceId,
        problemId: problem.id,
        step: entry.step as 1 | 2 | 3,
        sendAt: entry.scheduled_at,
        topicLabel: topicLabelOf(problem.topic_id),
        daysSince: entry.days,
        // 通知の言語は問題の topic_id から引く。端末の設定ではなくこちらが正。
        locale: localeOfTopicId(problem.topic_id),
      });
      externalId = scheduled.externalId;
    } catch (error) {
      // 通知の予約に失敗しても、完了応答は返す。プッシュのために体験を止めない。
      log?.error("practice_schedule_failed", error, {
        session_id: problem.session_id,
        problem_id: problem.id,
      });
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
}

export async function buildResponse(input: {
  repository: Repository;
  at: Date;
  session: SessionRecord;
  problem: PracticeProblemRecord | null;
  /** 今回この応答で予約した段。再送で拾い直したときだけ中身が入る。 */
  schedule?: PracticeScheduleEntry[];
  limits: Limits;
}): Promise<CompleteSessionResponse> {
  const { repository, at, session, problem, schedule = [], limits } = input;

  const localDate = toLocalDate(at);
  const [sessionDates, problems, attempts, user, usage] = await Promise.all([
    repository.sessionDates(session.device_id),
    repository.listPracticeProblems(session.device_id),
    repository.listPracticeAttempts(session.device_id),
    repository.getUser(session.device_id),
    repository.getDailySessionUsage(session.device_id, localDate),
  ]);

  const sessionLimits = sessionLimitsPayload({ user, usage, at, limits });
  return {
    practice_problem: problem === null ? null : toPracticeProblem(problem),
    practice_schedule: schedule,
    progress: computeProgress({ sessionDates, problems, attempts, today: localDate }),
    limits: sessionLimits,
    show_paywall: shouldShowPaywall({
      isPremium: hasPremiumAccess({ user, now: at, limits }),
      lessonAllowedToday: sessionLimits.lesson_allowed_today,
    }),
  };
}

/** 完了実績で仮押さえを精算した直後の、ホームと同じ日次残高。 */
function sessionLimitsPayload(input: {
  user: UserRecord | null;
  usage: DailySessionUsage;
  at: Date;
  limits: Limits;
}): {
  max_seconds: number;
  remaining_seconds_today: number;
  lesson_allowed_today: boolean;
} {
  const remainingSecondsToday = Math.max(
    0,
    secondsPerDay({ user: input.user, now: input.at, limits: input.limits }) -
      input.usage.consumedSeconds,
  );
  return {
    max_seconds: sessionMaxSeconds({ user: input.user, now: input.at, limits: input.limits }),
    remaining_seconds_today: remainingSecondsToday,
    lesson_allowed_today: canStartSessionToday({
      remainingSecondsToday,
      sessionsToday: input.usage.sessionsStarted,
      maxStartsPerDay: sessionStartsPerDay({
        user: input.user,
        now: input.at,
        limits: input.limits,
      }),
    }),
  };
}

/**
 * GET /v1/sessions/{id}/result — アプリが会話後に結果を取りに来る。
 *
 * **アプリはもうこれを待っていない**(祝福画面は生成を待たない。ADR 0009 の決定14)。
 * 残しているのは、残り時間の反映と「今日の問題ができたか」を後から確かめる口として。
 * まだ `/complete` が届いていなければ 202 を返す。
 */
completeRoute.get("/:sessionId/result", async (c) => {
  const { repository, now } = c.get("services");
  const deviceId = c.get("deviceId");
  const at = now();

  const session = await repository.getSession(c.req.param("sessionId"));
  if (!session || session.device_id !== deviceId) throw apiError("session_not_found");

  if (session.status !== "completed") {
    // agent がまだ `/complete` を投げていない。アプリはこの状態を「まだ」として扱う。
    return c.json({ status: "pending" }, 202);
  }

  const problem = await repository.getPracticeProblemBySession(session.id);
  return c.json(
    await buildResponse({ repository, at, session, problem, limits: readLimits(c.env) }),
    200,
  );
});
