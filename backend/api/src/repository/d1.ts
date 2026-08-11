import { studyRoomDailyMaxSeconds } from "@ai-sensei/contract";
import type { D1Database } from "../cloudflare.ts";
import type {
  HoleRecord,
  KarteRecord,
  Repository,
  ReviewScheduleRecord,
  SessionContext,
  SessionRecord,
  SessionReservation,
  StudyRoomDailyRecord,
  StudyRoomVisitWrite,
  UserRecord,
} from "./types.ts";

type UserRow = {
  device_id: string;
  created_at: string;
  is_premium: number;
  premium_expires_at: string | null;
  rc_app_user_id: string | null;
};

type SessionRow = Omit<SessionRecord, "topic_ids" | "context"> & {
  topic_ids: string;
  context: string | null;
};
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

  async reserveSessionSlot(input: {
    session: SessionRecord;
    maxPerDay: number;
  }): Promise<SessionReservation> {
    const { session } = input;
    const insert = this.db
      .prepare(
        `INSERT INTO sessions
           (id, device_id, kind, status, created_at, completed_at, local_date,
            photo_key, topic_ids, hole_id, duration_seconds, context)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM sessions WHERE device_id = ? AND local_date = ?) < ?`,
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
        session.context ? JSON.stringify(session.context) : null,
        session.device_id,
        session.local_date,
        input.maxPerDay,
      );
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE device_id = ? AND local_date = ?")
      .bind(session.device_id, session.local_date);

    /**
     * 上限確認とINSERTは同じSQL文に入れる。SQLiteでは1文が原子的に実行され、
     * 書き込みも直列化されるため、同時実行は同じ古いCOUNTを見たまま両方通れない。
     *
     * day_seqのUNIQUE INDEXは意図的に使わない。デプロイはマイグレーションが先なので、
     * 列を書かない旧Workerが既定値0を重ねる窓でINDEXがあると、2行目から失敗するため。
     * batchは同じトランザクションでINSERTと件数取得を行い、changesが0なら上限到達とする。
     */
    const results = await this.db.batch<{ count: number }>([insert, count]);
    const insertResult = results[0];
    if (!insertResult) throw new Error("授業枠のINSERT結果がありません");
    const changes = changesOf(insertResult.meta);

    const countResult = results[1];
    const sessionsToday = countResult?.results[0]?.count;
    if (typeof sessionsToday !== "number") {
      throw new Error("授業枠の確保後の件数を読み取れません");
    }
    if (changes === 0) return { reserved: false };
    return { reserved: true, sessionsToday };
  }

  async updateSessionTopics(input: {
    sessionId: string;
    topicIds: string[];
    photoKey: string | null;
    context: SessionContext | null;
  }): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET topic_ids = ?, photo_key = ?, context = ? WHERE id = ?")
      .bind(
        JSON.stringify(input.topicIds),
        input.photoKey,
        input.context ? JSON.stringify(input.context) : null,
        input.sessionId,
      )
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
    return row
      ? { ...row, topic_ids: parseJsonArray(row.topic_ids), context: parseContext(row.context) }
      : null;
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

  async listKartesOnLocalDates(input: {
    deviceId: string;
    fromDate: string;
    toDate: string;
  }): Promise<KarteRecord[]> {
    /**
     * 月の境界は sessions.local_date を正にする。kartes.created_at はUTCなので、
     * それだけで `2026-08-01` を比較するとJSTの月初9時間を前月へ落としてしまう。
     * セッションは主キーで結合でき、期間条件は既存の
     * `idx_sessions_device_date` に乗るので、新しいテーブルもマイグレーションも要らない。
     */
    const result = await this.db
      .prepare(
        `SELECT kartes.* FROM kartes
          INNER JOIN sessions ON sessions.id = kartes.session_id
          WHERE sessions.device_id = ?
            AND kartes.device_id = ?
            AND sessions.local_date >= ?
            AND sessions.local_date <= ?
          ORDER BY kartes.created_at DESC`,
      )
      .bind(input.deviceId, input.deviceId, input.fromDate, input.toDate)
      .all<KarteRow>();
    return result.results.map((row) => ({
      ...row,
      topic_ids: parseJsonArray(row.topic_ids),
      said_well: parseJsonArray(row.said_well),
      term_notes: parseJsonArray(row.term_notes),
    }));
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
      .prepare("UPDATE holes SET status = 'filled', filled_at = ? WHERE id = ? AND status = 'open'")
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

  async recordStudyRoomVisit(input: {
    deviceId: string;
    localDate: string;
    durationSeconds: number;
    visitId: string;
    recordedAt: string;
  }): Promise<StudyRoomVisitWrite> {
    const write = this.db
      .prepare(
        `INSERT INTO study_room_daily
           (device_id, local_date, total_seconds, last_visit_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id, local_date) DO UPDATE SET
           total_seconds = MIN(?, study_room_daily.total_seconds + excluded.total_seconds),
           last_visit_id = excluded.last_visit_id,
           updated_at = excluded.updated_at
         WHERE study_room_daily.last_visit_id <> excluded.last_visit_id
           AND study_room_daily.total_seconds < ?`,
      )
      .bind(
        input.deviceId,
        input.localDate,
        input.durationSeconds,
        input.visitId,
        input.recordedAt,
        studyRoomDailyMaxSeconds,
        studyRoomDailyMaxSeconds,
      );
    const read = this.db
      .prepare("SELECT * FROM study_room_daily WHERE device_id = ? AND local_date = ?")
      .bind(input.deviceId, input.localDate);

    /**
     * 加算と読み取りを同じbatchに入れる。構造化ログへ出す日次合計が、直後の別訪問を
     * 偶然読んだ値にならないようにするため。UPSERTの1文が加算の原子性を担い、
     * `last_visit_id` が同じならchanges=0なので二重送信も同じ経路で判定できる。
     */
    const results = await this.db.batch<StudyRoomDailyRecord>([write, read]);
    const writeResult = results[0];
    if (!writeResult) throw new Error("自習室の日次集計結果がありません");
    const changes = studyRoomChangesOf(writeResult.meta);

    const daily = results[1]?.results[0];
    if (!daily) throw new Error("自習室の日次集計を読み取れません");
    return { recorded: changes > 0, daily };
  }
}

/** metaの形が変わったとき、全員を上限到達として黙って止めずに異常を表へ出す。 */
function changesOf(meta: Record<string, unknown>): number {
  const changes = meta["changes"];
  if (typeof changes !== "number") throw new Error("授業枠のINSERT件数を読み取れません");
  return changes;
}

/** 二重送信を成功扱いのまま見分けるため、D1が返した書き込み件数を必ず検査する。 */
function studyRoomChangesOf(meta: Record<string, unknown>): number {
  const changes = meta["changes"];
  if (typeof changes !== "number") throw new Error("自習室のUPSERT件数を読み取れません");
  return changes;
}

type HoleRow = Omit<HoleRecord, "desc"> & { description: string };

function toHole(row: HoleRow): HoleRecord {
  const { description, ...rest } = row;
  return { ...rest, desc: description };
}

function toUser(row: UserRow): UserRecord {
  return { ...row, is_premium: row.is_premium === 1 };
}

/** 0002以前に作られた行では null。読めない値も null 扱いにして落とさない。 */
function parseContext(value: string | null): SessionContext | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as SessionContext) : null;
  } catch {
    return null;
  }
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
