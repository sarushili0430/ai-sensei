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
 * For tests and `wrangler dev --local`.
 * Both go through the same tests so behaviour matches the D1 implementation (d1.ts).
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
     * JavaScript is single-threaded, so with no await between the check and the
     * insert this stretch is atomic. Adding an await here would let another
     * request see the same "still room" in the gap and pass.
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

    // A resend is not recounted. The first claim stands; only the day's count is returned.
    if (session.started_at !== null) {
      return {
        started: true,
        alreadyStarted: true,
        sessionsToday: this.startedOnDate(session.device_id, session.local_date).length,
      };
    }

    const startedToday = this.startedOnDate(input.deviceId, input.localDate).length;
    if (startedToday >= input.maxPerDay) return { started: false };

    /** As in D1, no await between the check and the write (one would let concurrent requests both pass). */
    this.sessions.set(session.id, {
      ...session,
      started_at: input.startedAt,
      // The day counted is the day the conversation started, so a session analysed
      // before midnight is not counted on the photo's day (same as D1's UPDATE).
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
      // Reproduces the same conflict as D1's UNIQUE(device_id). Letting only the test
      // implementation be last-write-wins would hide the property that a doubly opened
      // first session does not overwrite an existing plan in production.
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
     * No await between the check and the two Map updates. Even in the test
     * implementation, this preserves the same boundary as production D1: a resent
     * complete with different content cannot overwrite the current plan.
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
