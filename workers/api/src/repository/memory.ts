import type {
  HoleRecord,
  KarteRecord,
  Repository,
  ReviewScheduleRecord,
  SessionRecord,
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

  async countSessionsOnDate(deviceId: string, localDate: string): Promise<number> {
    return [...this.sessions.values()].filter(
      (session) => session.device_id === deviceId && session.local_date === localDate,
    ).length;
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
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
    if (!hole) return;
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
}
