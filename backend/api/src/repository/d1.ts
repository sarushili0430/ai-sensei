import { type StudyPlan, studyPlanSchema } from "@ai-sensei/contract";
import type { D1Database } from "../cloudflare.ts";
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
type StudyPlanRow = Omit<StudyPlan, "intake" | "days" | "revisions"> & {
  intake: string;
  days: string;
  revisions: string;
  device_id: string;
  updated_at: string;
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

  async countStartedSessionsOnDate(deviceId: string, localDate: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE device_id = ? AND local_date = ? AND started_at IS NOT NULL`,
      )
      .bind(deviceId, localDate)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async createSession(input: {
    session: SessionRecord;
    maxAnalysesPerDay: number;
  }): Promise<boolean> {
    const { session } = input;
    /**
     * The cap check and the INSERT live in one SQL statement. SQLite runs a
     * statement atomically and serializes writes, so concurrent requests cannot
     * both pass while seeing the same stale COUNT.
     *
     * What is counted here is every row created that day (started_at is
     * ignored). Analysis cost is incurred whether or not a conversation began,
     * so sessions that never started count toward this cap.
     *
     * A UNIQUE INDEX on day_seq is deliberately avoided. Migrations deploy
     * first, so during the window where an old Worker omits the column and
     * repeats the default 0, an index would fail from the second row on.
     */
    const insert = await this.db
      .prepare(
        `INSERT INTO sessions
           (id, device_id, kind, status, created_at, completed_at, local_date,
            photo_key, topic_ids, hole_id, duration_seconds, context, started_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        session.started_at,
        session.device_id,
        session.local_date,
        input.maxAnalysesPerDay,
      )
      .run();
    return changesOf(insert.meta) > 0;
  }

  async startSession(input: {
    sessionId: string;
    deviceId: string;
    startedAt: string;
    localDate: string;
    maxPerDay: number;
  }): Promise<SessionStartResult> {
    /**
     * Claiming the lesson slot is this one statement. Because the cap check and
     * the `started_at` write are in the same statement, two simultaneous presses
     * cannot both pass on the same stale COUNT.
     *
     * `started_at IS NULL` is in the condition, so a resend is not counted twice
     * (changes becomes 0 and it is re-read below as "already started").
     */
    const start = this.db
      .prepare(
        `UPDATE sessions
            SET started_at = ?, local_date = ?
          WHERE id = ?
            AND device_id = ?
            AND started_at IS NULL
            AND (
              SELECT COUNT(*) FROM sessions AS counted
               WHERE counted.device_id = ?
                 AND counted.local_date = ?
                 AND counted.started_at IS NOT NULL
            ) < ?`,
      )
      .bind(
        input.startedAt,
        input.localDate,
        input.sessionId,
        input.deviceId,
        input.deviceId,
        input.localDate,
        input.maxPerDay,
      );
    // "Could not claim" and "already claimed" have opposite outcomes, so changes
    // alone cannot decide. Re-read the row in the same transaction.
    const read = this.db
      .prepare(
        `SELECT started_at,
                (SELECT COUNT(*) FROM sessions AS counted
                  WHERE counted.device_id = sessions.device_id
                    AND counted.local_date = sessions.local_date
                    AND counted.started_at IS NOT NULL) AS sessions_today
           FROM sessions
          WHERE id = ? AND device_id = ?`,
      )
      .bind(input.sessionId, input.deviceId);

    const results = await this.db.batch<{ started_at: string | null; sessions_today: number }>([
      start,
      read,
    ]);
    const startResult = results[0];
    if (!startResult) throw new Error("授業枠のUPDATE結果がありません");
    const changes = changesOf(startResult.meta);

    const row = results[1]?.results[0];
    if (!row) return { started: false };
    if (changes > 0)
      return { started: true, alreadyStarted: false, sessionsToday: row.sessions_today };
    // Not updated yet started = a previously claimed slot is still alive.
    if (row.started_at !== null) {
      return { started: true, alreadyStarted: true, sessionsToday: row.sessions_today };
    }
    return { started: false };
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
               (id, device_id, karte_id, topic_id, description, severity, evidence, quiz, status, created_at, filled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            hole.id,
            hole.device_id,
            hole.karte_id,
            hole.topic_id,
            hole.desc,
            hole.severity,
            hole.evidence,
            hole.quiz,
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
     * sessions.local_date is authoritative for the month boundary. kartes.created_at
     * is UTC, so comparing `2026-08-01` on that alone would push JST's first nine
     * hours into the previous month. Sessions join on the primary key and the
     * period condition rides the existing `idx_sessions_device_date`, so no new
     * table and no migration are needed.
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

  async createPlanSession(session: PlanSessionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO plan_sessions
           (id, device_id, locale, status, created_at, completed_at, duration_seconds, plan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        session.device_id,
        session.locale,
        session.status,
        session.created_at,
        session.completed_at,
        session.duration_seconds,
        session.plan_id,
      )
      .run();
  }

  async getPlanSession(planSessionId: string): Promise<PlanSessionRecord | null> {
    return this.db
      .prepare("SELECT * FROM plan_sessions WHERE id = ?")
      .bind(planSessionId)
      .first<PlanSessionRecord>();
  }

  async getCurrentPlan(deviceId: string): Promise<StudyPlan | null> {
    const row = await this.db
      .prepare("SELECT * FROM study_plans WHERE device_id = ?")
      .bind(deviceId)
      .first<StudyPlanRow>();
    return row ? toStudyPlan(row) : null;
  }

  async getPlan(planId: string): Promise<StudyPlan | null> {
    const row = await this.db
      .prepare("SELECT * FROM study_plans WHERE id = ?")
      .bind(planId)
      .first<StudyPlanRow>();
    return row ? toStudyPlan(row) : null;
  }

  async completePlanSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
    plan: StudyPlan;
  }): Promise<boolean> {
    const { plan } = input;
    const save = this.db
      .prepare(
        `INSERT INTO study_plans
           (id, device_id, created_at, updated_at, source, intake, days, revisions)
         SELECT ?, plan_sessions.device_id, ?, ?, ?, ?, ?, ?
           FROM plan_sessions
          WHERE plan_sessions.id = ? AND plan_sessions.status = 'open'
         ON CONFLICT(device_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           source = excluded.source,
           intake = excluded.intake,
           days = excluded.days,
           revisions = excluded.revisions
         WHERE study_plans.id = excluded.id`,
      )
      .bind(
        plan.id,
        plan.created_at,
        input.completedAt,
        plan.source,
        JSON.stringify(plan.intake),
        JSON.stringify(plan.days),
        JSON.stringify(plan.revisions),
        input.sessionId,
      );
    const finish = this.db
      .prepare(
        `UPDATE plan_sessions
            SET status = 'completed',
                completed_at = ?,
                duration_seconds = ?,
                plan_id = (
                  SELECT id FROM study_plans WHERE device_id = plan_sessions.device_id
                )
          WHERE id = ?
            AND status = 'open'
            AND EXISTS (
              SELECT 1 FROM study_plans WHERE device_id = plan_sessions.device_id
            )`,
      )
      .bind(input.completedAt, input.durationSeconds, input.sessionId);

    /**
     * If the save and the completion mark succeed separately, a resend produces
     * either "completed but no plan" or "plan changed but session open". D1
     * batch atomicity binds the two statements: on a resend that lost the race,
     * the first statement's SELECT returns nothing and the current plan is not
     * overwritten. And if the first room is opened twice and completed
     * concurrently with different plan ids, the later UPSERT is refused by the
     * WHERE. Replacing an existing id would not only break the earlier session's
     * foreign key but lose the historical continuity of "the same plan, rebuilt".
     * The finish side re-reads the id actually stored on the device, so the later
     * session also closes safely.
     */
    const results = await this.db.batch([save, finish]);
    const saveResult = results[0];
    if (!saveResult) throw new Error("計画の保存結果がありません");
    return changesOf(saveResult.meta) > 0;
  }
}

/** When meta's shape changes, surface the anomaly instead of silently capping everyone. */
function changesOf(meta: Record<string, unknown>): number {
  const changes = meta["changes"];
  if (typeof changes !== "number") throw new Error("書き込んだ行数を読み取れません");
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

/** null on rows created before 0002. Unreadable values are treated as null rather than throwing. */
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

/**
 * Type-asserting JSON columns individually lets broken rows leak into API
 * responses. A saved plan is primary data that future parent reports also read,
 * so validate the whole contract before returning it.
 */
function toStudyPlan(row: StudyPlanRow): StudyPlan {
  return studyPlanSchema.parse({
    id: row.id,
    created_at: row.created_at,
    source: row.source,
    intake: JSON.parse(row.intake) as unknown,
    days: JSON.parse(row.days) as unknown,
    revisions: JSON.parse(row.revisions) as unknown,
  });
}
