import type { D1Database } from "../cloudflare.ts";
import type {
  HoleRecord,
  KarteRecord,
  Repository,
  ReviewScheduleRecord,
  SessionRecord,
  UserRecord,
} from "./types.ts";

type UserRow = {
  device_id: string;
  created_at: string;
  is_premium: number;
  premium_expires_at: string | null;
  rc_app_user_id: string | null;
};

type SessionRow = Omit<SessionRecord, "topic_ids"> & { topic_ids: string };
type KarteRow = Omit<KarteRecord, "topic_ids" | "said_well" | "term_notes"> & {
  topic_ids: string;
  said_well: string;
  term_notes: string;
};

export class D1Repository implements Repository {
  constructor(private readonly db: D1Database) {}

  async ensureUser(deviceId: string, now: Date): Promise<UserRecord> {
    await this.db
      .prepare("INSERT OR IGNORE INTO users (device_id, created_at) VALUES (?, ?)")
      .bind(deviceId, now.toISOString())
      .run();
    const user = await this.getUser(deviceId);
    if (!user) throw new Error(`ユーザーの作成に失敗しました: ${deviceId}`);
    return user;
  }

  async getUser(deviceId: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE device_id = ?")
      .bind(deviceId)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async setPremium(input: {
    deviceId: string;
    isPremium: boolean;
    expiresAt: string | null;
    rcAppUserId: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE users
            SET is_premium = ?, premium_expires_at = ?, rc_app_user_id = COALESCE(?, rc_app_user_id)
          WHERE device_id = ?`,
      )
      .bind(input.isPremium ? 1 : 0, input.expiresAt, input.rcAppUserId, input.deviceId)
      .run();
  }

  async countSessionsOnDate(deviceId: string, localDate: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE device_id = ? AND local_date = ?")
      .bind(deviceId, localDate)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions
           (id, device_id, kind, status, created_at, completed_at, local_date,
            photo_key, topic_ids, hole_id, duration_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        session.device_id,
        session.kind,
        session.status,
        session.created_at,
        session.completed_at,
        session.local_date,
        session.photo_key,
        JSON.stringify(session.topic_ids),
        session.hole_id,
        session.duration_seconds,
      )
      .run();
  }

  async updateSessionTopics(input: {
    sessionId: string;
    topicIds: string[];
    photoKey: string | null;
  }): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET topic_ids = ?, photo_key = ? WHERE id = ?")
      .bind(JSON.stringify(input.topicIds), input.photoKey, input.sessionId)
      .run();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<SessionRow>();
    return row ? { ...row, topic_ids: parseJsonArray(row.topic_ids) } : null;
  }

  async completeSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions SET status = 'completed', completed_at = ?, duration_seconds = ?
          WHERE id = ?`,
      )
      .bind(input.completedAt, input.durationSeconds, input.sessionId)
      .run();
  }

  async sessionDates(deviceId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT DISTINCT local_date FROM sessions
          WHERE device_id = ? AND status = 'completed' ORDER BY local_date`,
      )
      .bind(deviceId)
      .all<{ local_date: string }>();
    return result.results.map((row) => row.local_date);
  }

  async insertKarte(karte: KarteRecord, holes: HoleRecord[]): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `INSERT INTO kartes
             (id, session_id, device_id, created_at, topic_ids, said_well, term_notes, followup_question)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          karte.id,
          karte.session_id,
          karte.device_id,
          karte.created_at,
          JSON.stringify(karte.topic_ids),
          JSON.stringify(karte.said_well),
          JSON.stringify(karte.term_notes),
          karte.followup_question,
        ),
      ...holes.map((hole) =>
        this.db
          .prepare(
            `INSERT INTO holes
               (id, device_id, karte_id, topic_id, description, severity, evidence, status, created_at, filled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            hole.id,
            hole.device_id,
            hole.karte_id,
            hole.topic_id,
            hole.desc,
            hole.severity,
            hole.evidence,
            hole.status,
            hole.created_at,
            hole.filled_at,
          ),
      ),
    ];
    await this.db.batch(statements);
  }

  async getKarte(karteId: string): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null> {
    const row = await this.db
      .prepare("SELECT * FROM kartes WHERE id = ?")
      .bind(karteId)
      .first<KarteRow>();
    if (!row) return null;
    const holes = await this.db
      .prepare("SELECT * FROM holes WHERE karte_id = ? ORDER BY created_at")
      .bind(karteId)
      .all<HoleRow>();
    return {
      karte: {
        ...row,
        topic_ids: parseJsonArray(row.topic_ids),
        said_well: parseJsonArray(row.said_well),
        term_notes: parseJsonArray(row.term_notes),
      },
      holes: holes.results.map(toHole),
    };
  }

  async getKarteBySession(
    sessionId: string,
  ): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null> {
    const row = await this.db
      .prepare("SELECT id FROM kartes WHERE session_id = ?")
      .bind(sessionId)
      .first<{ id: string }>();
    return row ? this.getKarte(row.id) : null;
  }

  async listHoles(deviceId: string): Promise<HoleRecord[]> {
    const result = await this.db
      .prepare("SELECT * FROM holes WHERE device_id = ? ORDER BY created_at")
      .bind(deviceId)
      .all<HoleRow>();
    return result.results.map(toHole);
  }

  async getHole(holeId: string): Promise<HoleRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM holes WHERE id = ?")
      .bind(holeId)
      .first<HoleRow>();
    return row ? toHole(row) : null;
  }

  async markHoleFilled(holeId: string, filledAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE holes SET status = 'filled', filled_at = ? WHERE id = ?")
      .bind(filledAt, holeId)
      .run();
  }

  async insertReviewSchedules(entries: ReviewScheduleRecord[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.batch(
      entries.map((entry) =>
        this.db
          .prepare(
            `INSERT INTO review_schedules (id, hole_id, step, scheduled_at, external_id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(entry.id, entry.hole_id, entry.step, entry.scheduled_at, entry.external_id),
      ),
    );
  }

  async cancelReviewSchedules(holeId: string): Promise<ReviewScheduleRecord[]> {
    const result = await this.db
      .prepare("SELECT * FROM review_schedules WHERE hole_id = ?")
      .bind(holeId)
      .all<ReviewScheduleRecord>();
    await this.db.prepare("DELETE FROM review_schedules WHERE hole_id = ?").bind(holeId).run();
    return result.results;
  }
}

type HoleRow = Omit<HoleRecord, "desc"> & { description: string };

function toHole(row: HoleRow): HoleRecord {
  const { description, ...rest } = row;
  return { ...rest, desc: description };
}

function toUser(row: UserRow): UserRecord {
  return { ...row, is_premium: row.is_premium === 1 };
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
