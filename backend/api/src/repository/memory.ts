import type { StudyPlan } from "@ai-sensei/contract";
import type {
  HoleRecord,
  KarteRecord,
  PlanSessionRecord,
  Repository,
  ReviewScheduleRecord,
  SessionContext,
  SessionRecord,
  SessionStartResult,
  UserRecord,
} from "./types.ts";

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

  async countStartedSessionsOnDate(deviceId: string, localDate: string): Promise<number> {
    return this.startedOnDate(deviceId, localDate).length;
  }

  async createSession(input: {
    session: SessionRecord;
    maxAnalysesPerDay: number;
  }): Promise<boolean> {
    const analysesToday = [...this.sessions.values()].filter(
      (session) =>
        session.device_id === input.session.device_id &&
        session.local_date === input.session.local_date,
    ).length;
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
    maxPerDay: number;
  }): Promise<SessionStartResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.device_id !== input.deviceId) return { started: false };

    // 再送は数え直さない。最初に押さえた枠のまま、その日の本数だけを返す。
    if (session.started_at !== null) {
      return {
        started: true,
        alreadyStarted: true,
        sessionsToday: this.startedOnDate(session.device_id, session.local_date).length,
      };
    }

    const startedToday = this.startedOnDate(input.deviceId, input.localDate).length;
    if (startedToday >= input.maxPerDay) return { started: false };

    /** D1と同じく、確認から書き込みまでawaitを挟まない(挟むと同時実行が両方通る)。 */
    this.sessions.set(session.id, {
      ...session,
      started_at: input.startedAt,
      // 数える日は「会話が始まった日」。解析だけして日付をまたいだ回を、
      // 撮った日のほうへ数えないため(D1側の UPDATE と同じ)。
      local_date: input.localDate,
    });
    return { started: true, alreadyStarted: false, sessionsToday: startedToday + 1 };
  }

  private startedOnDate(deviceId: string, localDate: string): SessionRecord[] {
    return [...this.sessions.values()].filter(
      (session) =>
        session.device_id === deviceId &&
        session.local_date === localDate &&
        session.started_at !== null,
    );
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
