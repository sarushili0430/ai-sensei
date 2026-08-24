import type { StudyPlan } from "@ai-sensei/contract";
import type {
  DailySessionUsage,
  HoleRecord,
  KarteRecord,
  PlanSessionRecord,
  PracticeAttemptRecord,
  PracticeProblemRecord,
  PracticeScheduleRecord,
  Repository,
  ReviewScheduleRecord,
  SessionContext,
  SessionRecord,
  SessionStartResult,
  UserRecord,
} from "./types.ts";
import { legacySessionMaxSeconds } from "./types.ts";

/**
 * テストと `wrangler dev --local` の代替用。
 * D1実装(d1.ts)と同じ振る舞いになるよう、両方を同じテストに通す。
 */
export class MemoryRepository implements Repository {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly kartes = new Map<string, KarteRecord>();
  readonly holes = new Map<string, HoleRecord>();
  readonly schedules: ReviewScheduleRecord[] = [];
  readonly practiceProblems = new Map<string, PracticeProblemRecord>();
  readonly practiceAttempts: PracticeAttemptRecord[] = [];
  readonly practiceSchedules: PracticeScheduleRecord[] = [];
  readonly planSessions = new Map<string, PlanSessionRecord>();
  readonly plans = new Map<string, StudyPlan>();

  async ensureUser(deviceId: string, now: Date): Promise<UserRecord> {
    const existing = this.users.get(deviceId);
    if (existing) return existing;
    const user: UserRecord = {
      device_id: deviceId,
      created_at: now.toISOString(),
      is_premium: false,
      premium_expires_at: null,
      rc_app_user_id: null,
    };
    this.users.set(deviceId, user);
    return user;
  }

  async getUser(deviceId: string): Promise<UserRecord | null> {
    return this.users.get(deviceId) ?? null;
  }

  async setPremium(input: {
    deviceId: string;
    isPremium: boolean;
    expiresAt: string | null;
    rcAppUserId: string | null;
  }): Promise<void> {
    const user = this.users.get(input.deviceId);
    if (!user) return;
    this.users.set(input.deviceId, {
      ...user,
      is_premium: input.isPremium,
      premium_expires_at: input.expiresAt,
      rc_app_user_id: input.rcAppUserId ?? user.rc_app_user_id,
    });
  }

  async getDailySessionUsage(deviceId: string, localDate: string): Promise<DailySessionUsage> {
    return this.dailySessionUsage(deviceId, localDate);
  }

  private dailySessionUsage(deviceId: string, localDate: string): DailySessionUsage {
    const sessions = this.startedOnDate(deviceId, localDate);
    return {
      consumedSeconds: sessions.reduce(
        (total, session) =>
          total + (session.duration_seconds ?? session.max_seconds ?? legacySessionMaxSeconds),
        0,
      ),
      sessionsStarted: sessions.length,
    };
  }

  async settleExpiredSessions(input: {
    deviceId: string;
    now: string;
    graceSeconds: number;
  }): Promise<number> {
    // D1と同じく時間だけを精算し、カルテの無い離脱をstreakには数えない。
    const nowMs = new Date(input.now).getTime();
    let settled = 0;
    for (const session of this.sessions.values()) {
      if (
        session.device_id !== input.deviceId ||
        session.started_at === null ||
        session.quota_settled_at !== null
      ) {
        continue;
      }

      const startedMs = new Date(session.started_at).getTime();
      const maxSeconds = session.max_seconds ?? legacySessionMaxSeconds;
      const expired =
        Number.isNaN(startedMs) || startedMs + (maxSeconds + input.graceSeconds) * 1000 < nowMs;
      if (session.duration_seconds === null && !expired) continue;

      this.sessions.set(session.id, {
        ...session,
        duration_seconds: session.duration_seconds ?? maxSeconds,
        quota_settled_at: session.completed_at ?? input.now,
      });
      settled += 1;
    }
    return settled;
  }

  async createSession(input: {
    session: SessionRecord;
    maxAnalysesPerDay: number;
  }): Promise<boolean> {
    const analysesToday = [...this.sessions.values()]
      .filter(
        (session) =>
          session.device_id === input.session.device_id &&
          session.local_date === input.session.local_date,
      )
      .reduce((total, session) => total + session.analysis_count, 0);
    if (analysesToday >= input.maxAnalysesPerDay) return false;

    /**
     * JavaScriptは単一スレッドなので、確認から挿入までawaitを挟まなければこの区間は原子的になる。
     * ここにawaitを足すと、その隙間で別のリクエストが同じ「まだ空きがある」を見て通る。
     */
    this.sessions.set(input.session.id, input.session);
    return true;
  }

  async startSession(input: {
    sessionId: string;
    deviceId: string;
    startedAt: string;
    localDate: string;
    secondsPerDay: number;
    sessionMaxSeconds: number;
    minimumSessionSeconds: number;
    maxStartsPerDay: number;
  }): Promise<SessionStartResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.device_id !== input.deviceId) return { started: false };

    // 再送は数え直さない。最初に押さえた枠のまま、その日の本数だけを返す。
    if (session.started_at !== null) {
      const usage = this.dailySessionUsage(input.deviceId, input.localDate);
      return {
        started: true,
        alreadyStarted: true,
        sessionsToday: usage.sessionsStarted,
        maxSeconds: session.max_seconds ?? legacySessionMaxSeconds,
        remainingSecondsToday: Math.max(0, input.secondsPerDay - usage.consumedSeconds),
      };
    }

    // D1の条件付きUPDATEと同じく、確認から書き込みまでawaitを挟まない。
    // ここでyieldすると、同時開始が全員同じ古い残高を見られる。
    const usage = this.dailySessionUsage(input.deviceId, input.localDate);
    const remainingSeconds = Math.max(0, input.secondsPerDay - usage.consumedSeconds);
    if (
      remainingSeconds < input.minimumSessionSeconds ||
      usage.sessionsStarted >= input.maxStartsPerDay
    ) {
      return { started: false };
    }
    const maxSeconds = Math.min(input.sessionMaxSeconds, remainingSeconds);

    /** D1と同じく、確認から書き込みまでawaitを挟まない(挟むと同時実行が両方通る)。 */
    this.sessions.set(session.id, {
      ...session,
      started_at: input.startedAt,
      // 数える日は「会話が始まった日」。解析だけして日付をまたいだ回を、
      // 撮った日のほうへ数えないため(D1側の UPDATE と同じ)。
      local_date: input.localDate,
      max_seconds: maxSeconds,
      quota_settled_at: null,
    });
    return {
      started: true,
      alreadyStarted: false,
      sessionsToday: usage.sessionsStarted + 1,
      maxSeconds,
      remainingSecondsToday: remainingSeconds - maxSeconds,
    };
  }

  private startedOnDate(deviceId: string, localDate: string): SessionRecord[] {
    return [...this.sessions.values()].filter(
      (session) =>
        session.device_id === deviceId &&
        session.local_date === localDate &&
        session.started_at !== null,
    );
  }

  async reserveSessionAnalysis(input: {
    sessionId: string;
    deviceId: string;
    localDate: string;
    maxAnalysesPerSession: number;
    maxAnalysesPerDay: number;
  }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    const analysesToday = [...this.sessions.values()]
      .filter(
        (candidate) =>
          candidate.device_id === input.deviceId && candidate.local_date === input.localDate,
      )
      .reduce((total, candidate) => total + candidate.analysis_count, 0);
    if (
      !session ||
      session.device_id !== input.deviceId ||
      session.kind !== "new" ||
      session.status !== "open" ||
      session.started_at === null ||
      session.analysis_count >= input.maxAnalysesPerSession ||
      analysesToday >= input.maxAnalysesPerDay
    ) {
      return false;
    }

    // D1の条件付きUPDATEと同じく、確認から書き込みまでawaitを挟まない。
    this.sessions.set(session.id, { ...session, analysis_count: session.analysis_count + 1 });
    return true;
  }

  async releaseSessionAnalysis(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(session.id, {
      ...session,
      // 初回解析の1枠は、追加写真が失敗しても返さない。
      analysis_count: Math.max(1, session.analysis_count - 1),
    });
  }

  async updateSessionContextIfRevision(input: {
    sessionId: string;
    expectedRevision: number;
    topicIds: string[];
    context: SessionContext;
  }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    if (
      !session ||
      session.status !== "open" ||
      (session.context?.revision ?? 1) !== input.expectedRevision
    ) {
      return false;
    }
    this.sessions.set(session.id, {
      ...session,
      topic_ids: input.topicIds,
      context: input.context,
    });
    return true;
  }

  async updateSessionTopics(input: {
    sessionId: string;
    topicIds: string[];
    photoKey: string | null;
    context: SessionContext | null;
  }): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    this.sessions.set(input.sessionId, {
      ...session,
      topic_ids: input.topicIds,
      photo_key: input.photoKey,
      context: input.context,
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async completeSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
  }): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    this.sessions.set(input.sessionId, {
      ...session,
      status: "completed",
      completed_at: input.completedAt,
      duration_seconds: input.durationSeconds,
      quota_settled_at: input.completedAt,
    });
  }

  async sessionDates(deviceId: string): Promise<string[]> {
    const dates = [...this.sessions.values()]
      .filter((session) => session.device_id === deviceId && session.status === "completed")
      .map((session) => session.local_date);
    return [...new Set(dates)].sort();
  }

  async insertKarte(karte: KarteRecord, holes: HoleRecord[]): Promise<void> {
    this.kartes.set(karte.id, karte);
    for (const hole of holes) this.holes.set(hole.id, hole);
  }

  async getKarte(karteId: string): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null> {
    const karte = this.kartes.get(karteId);
    if (!karte) return null;
    const holes = [...this.holes.values()].filter((hole) => hole.karte_id === karteId);
    return { karte, holes };
  }

  async getKarteBySession(
    sessionId: string,
  ): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null> {
    const karte = [...this.kartes.values()].find((entry) => entry.session_id === sessionId);
    return karte ? this.getKarte(karte.id) : null;
  }

  async listKartesOnLocalDates(input: {
    deviceId: string;
    fromDate: string;
    toDate: string;
  }): Promise<KarteRecord[]> {
    return [...this.kartes.values()]
      .filter((karte) => {
        if (karte.device_id !== input.deviceId) return false;
        const localDate = this.sessions.get(karte.session_id)?.local_date;
        return localDate !== undefined && localDate >= input.fromDate && localDate <= input.toDate;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listHoles(deviceId: string): Promise<HoleRecord[]> {
    return [...this.holes.values()]
      .filter((hole) => hole.device_id === deviceId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getHole(holeId: string): Promise<HoleRecord | null> {
    return this.holes.get(holeId) ?? null;
  }

  async markHoleFilled(holeId: string, filledAt: string): Promise<void> {
    const hole = this.holes.get(holeId);
    if (!hole || hole.status !== "open") return;
    this.holes.set(holeId, { ...hole, status: "filled", filled_at: filledAt });
  }

  async insertReviewSchedules(entries: ReviewScheduleRecord[]): Promise<void> {
    this.schedules.push(...entries);
  }

  async cancelReviewSchedules(holeId: string): Promise<ReviewScheduleRecord[]> {
    const cancelled = this.schedules.filter((entry) => entry.hole_id === holeId);
    for (const entry of cancelled) {
      this.schedules.splice(this.schedules.indexOf(entry), 1);
    }
    return cancelled;
  }

  async insertPracticeProblem(problem: PracticeProblemRecord): Promise<void> {
    // D1 の `idx_practice_problems_session`(UNIQUE)と同じ形で落とす。
    // ここが素通しだと、**同時に2本 /complete が来たときの二重通知**が
    // メモリ実装のテストでだけ再現しなくなる。
    const duplicate = [...this.practiceProblems.values()].some(
      (entry) => entry.session_id === problem.session_id,
    );
    if (duplicate) {
      throw new Error(`このセッションには既に復習問題があります: ${problem.session_id}`);
    }
    this.practiceProblems.set(problem.id, problem);
  }

  async getPracticeProblem(problemId: string): Promise<PracticeProblemRecord | null> {
    return this.practiceProblems.get(problemId) ?? null;
  }

  async getPracticeProblemBySession(sessionId: string): Promise<PracticeProblemRecord | null> {
    return (
      [...this.practiceProblems.values()].find((entry) => entry.session_id === sessionId) ?? null
    );
  }

  async listPracticeProblems(deviceId: string): Promise<PracticeProblemRecord[]> {
    return [...this.practiceProblems.values()]
      .filter((problem) => problem.device_id === deviceId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listPracticeAttempts(deviceId: string): Promise<PracticeAttemptRecord[]> {
    const owned = new Set(
      [...this.practiceProblems.values()]
        .filter((problem) => problem.device_id === deviceId)
        .map((problem) => problem.id),
    );
    return this.practiceAttempts
      .filter((attempt) => owned.has(attempt.problem_id))
      .sort((a, b) => a.answered_at.localeCompare(b.answered_at));
  }

  async insertPracticeAttempt(attempt: PracticeAttemptRecord): Promise<void> {
    this.practiceAttempts.push(attempt);
  }

  async insertPracticeSchedules(entries: PracticeScheduleRecord[]): Promise<void> {
    this.practiceSchedules.push(...entries);
  }

  async listPracticeSchedules(problemId: string): Promise<PracticeScheduleRecord[]> {
    return this.practiceSchedules
      .filter((entry) => entry.problem_id === problemId)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  }

  async createPlanSession(session: PlanSessionRecord): Promise<void> {
    this.planSessions.set(session.id, session);
  }

  async getPlanSession(planSessionId: string): Promise<PlanSessionRecord | null> {
    return this.planSessions.get(planSessionId) ?? null;
  }

  async getCurrentPlan(deviceId: string): Promise<StudyPlan | null> {
    const session = [...this.planSessions.values()]
      .filter((entry) => entry.device_id === deviceId && entry.plan_id !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return session?.plan_id ? (this.plans.get(session.plan_id) ?? null) : null;
  }

  async getPlan(planId: string): Promise<StudyPlan | null> {
    return this.plans.get(planId) ?? null;
  }

  async completePlanSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
    plan: StudyPlan;
  }): Promise<boolean> {
    const session = this.planSessions.get(input.sessionId);
    if (!session || session.status !== "open") return false;

    const currentSession = [...this.planSessions.values()]
      .filter((entry) => entry.device_id === session.device_id && entry.plan_id !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (currentSession?.plan_id && currentSession.plan_id !== input.plan.id) {
      // D1のUNIQUE(device_id)と同じ競合を再現する。テスト用実装だけ後勝ちにすると、
      // 二重に開いた初回セッションが本番で既存計画を上書きしない性質を検査できない。
      this.planSessions.set(input.sessionId, {
        ...session,
        status: "completed",
        completed_at: input.completedAt,
        duration_seconds: input.durationSeconds,
        plan_id: currentSession.plan_id,
      });
      return false;
    }

    /**
     * 確認から2つのMap更新までawaitを挟まない。テスト実装でも本番D1と同じく、
     * complete の再送が別内容で現行計画を上書きできない境界を保つため。
     */
    this.plans.set(input.plan.id, input.plan);
    this.planSessions.set(input.sessionId, {
      ...session,
      status: "completed",
      completed_at: input.completedAt,
      duration_seconds: input.durationSeconds,
      plan_id: input.plan.id,
    });
    return true;
  }
}
