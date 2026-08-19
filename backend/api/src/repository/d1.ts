import { type StudyPlan, studyPlanSchema } from "@ai-sensei/contract";
import type { D1Database } from "../cloudflare.ts";
import type {
  DailySessionUsage,
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
import { legacySessionMaxSeconds } from "./types.ts";

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

  async getDailySessionUsage(deviceId: string, localDate: string): Promise<DailySessionUsage> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(
             CASE
               WHEN duration_seconds IS NOT NULL THEN duration_seconds
               ELSE COALESCE(max_seconds, ${legacySessionMaxSeconds})
             END
           ), 0) AS consumed_seconds,
           COUNT(*) AS sessions_started
         FROM sessions
         WHERE device_id = ? AND local_date = ? AND started_at IS NOT NULL`,
      )
      .bind(deviceId, localDate)
      .first<{ consumed_seconds: number; sessions_started: number }>();
    return {
      consumedSeconds: row?.consumed_seconds ?? 0,
      sessionsStarted: row?.sessions_started ?? 0,
    };
  }

  async settleExpiredSessions(input: {
    deviceId: string;
    now: string;
    graceSeconds: number;
  }): Promise<number> {
    // ここで閉じるのは時間の会計だけ。statusまでcompletedにすると、カルテの無い
    // 離脱を「授業を完了した日」としてstreakへ混ぜてしまう。
    const settled = await this.db
      .prepare(
        `UPDATE sessions
            SET duration_seconds = COALESCE(duration_seconds, max_seconds, ${legacySessionMaxSeconds}),
                quota_settled_at = COALESCE(completed_at, ?)
          WHERE device_id = ?
            AND started_at IS NOT NULL
            AND quota_settled_at IS NULL
            AND (
              duration_seconds IS NOT NULL
              OR unixepoch(started_at) IS NULL
              OR unixepoch(started_at) + COALESCE(max_seconds, ${legacySessionMaxSeconds}) + ?
                   < unixepoch(?)
            )`,
      )
      .bind(input.now, input.deviceId, input.graceSeconds, input.now)
      .run();
    return changesOf(settled.meta);
  }

  async settleSessionEarly(input: {
    sessionId: string;
    deviceId: string;
    now: string;
  }): Promise<boolean> {
    // 実測を書けるのは、まだ誰も実測を書いていない行だけ(/complete の上書きは常に勝つ)。
    // 経過の計算をUPDATEに入れてあるので、読み取りと書き込みの間で別の精算と競合しない。
    const settled = await this.db
      .prepare(
        `UPDATE sessions
            SET duration_seconds = MIN(
                  COALESCE(max_seconds, ${legacySessionMaxSeconds}),
                  MAX(0, unixepoch(?) - unixepoch(started_at))
                ),
                quota_settled_at = ?
          WHERE id = ?
            AND device_id = ?
            AND started_at IS NOT NULL
            AND unixepoch(started_at) IS NOT NULL
            AND duration_seconds IS NULL`,
      )
      .bind(input.now, input.now, input.sessionId, input.deviceId)
      .run();
    return changesOf(settled.meta) > 0;
  }

  async createSession(input: {
    session: SessionRecord;
    maxAnalysesPerDay: number;
  }): Promise<boolean> {
    const { session } = input;
    /**
     * 上限確認とINSERTは同じSQL文に入れる。SQLiteでは1文が原子的に実行され、
     * 書き込みも直列化されるため、同時実行は同じ古いCOUNTを見たまま両方通れない。
     *
     * ここで数えるのは**その日の analysis_count の合計**(started_at は見ない)。
     * 解析の原価は会話を始めたかどうかに関係なく発生するので、始めなかった
     * セッションも、始めた会話へ追加した写真も同じ上限に数える。
     *
     * day_seqのUNIQUE INDEXは意図的に使わない。デプロイはマイグレーションが先なので、
     * 列を書かない旧Workerが既定値0を重ねる窓でINDEXがあると、2行目から失敗するため。
     */
    const insert = await this.db
      .prepare(
        `INSERT INTO sessions
           (id, device_id, kind, status, created_at, completed_at, local_date,
            photo_key, topic_ids, hole_id, duration_seconds, context, started_at,
            max_seconds, quota_settled_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COALESCE(SUM(analysis_count), 0) FROM sessions
                  WHERE device_id = ? AND local_date = ?) < ?`,
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
        session.max_seconds,
        session.quota_settled_at,
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
    secondsPerDay: number;
    sessionMaxSeconds: number;
    minimumSessionSeconds: number;
    maxStartsPerDay: number;
  }): Promise<SessionStartResult> {
    /**
     * 授業時間の確保 = この1文。実績 + 仮押さえのSUM、開始回数のガード、
     * `started_at` / `max_seconds` の書き込みが同じ文なので、同時開始も同じ残高を
     * 二重に使えない。
     *
     * `started_at IS NULL` を条件に入れてあるので、**再送は2度目を数えない**
     * (changesが0になり、下で「もう始まっている」として読み直される)。
     */
    const start = this.db
      .prepare(
        `UPDATE sessions
            SET started_at = ?,
                local_date = ?,
                max_seconds = MIN(
                  ?,
                  ? - COALESCE((
                    SELECT SUM(
                      CASE
                        WHEN counted.duration_seconds IS NOT NULL THEN counted.duration_seconds
                        ELSE COALESCE(counted.max_seconds, ${legacySessionMaxSeconds})
                      END
                    )
                    FROM sessions AS counted
                    WHERE counted.device_id = sessions.device_id
                      AND counted.local_date = ?
                      AND counted.started_at IS NOT NULL
                  ), 0)
                ),
                quota_settled_at = NULL
          WHERE id = ?
            AND device_id = ?
            AND status = 'open'
            AND started_at IS NULL
            AND ? - COALESCE((
              SELECT SUM(
                CASE
                  WHEN counted.duration_seconds IS NOT NULL THEN counted.duration_seconds
                  ELSE COALESCE(counted.max_seconds, ${legacySessionMaxSeconds})
                END
              )
              FROM sessions AS counted
              WHERE counted.device_id = sessions.device_id
                AND counted.local_date = ?
                AND counted.started_at IS NOT NULL
            ), 0) >= ?
            AND (
              SELECT COUNT(*)
              FROM sessions AS counted
              WHERE counted.device_id = sessions.device_id
                AND counted.local_date = ?
                AND counted.started_at IS NOT NULL
            ) < ?`,
      )
      .bind(
        input.startedAt,
        input.localDate,
        input.sessionMaxSeconds,
        input.secondsPerDay,
        input.localDate,
        input.sessionId,
        input.deviceId,
        input.secondsPerDay,
        input.localDate,
        input.minimumSessionSeconds,
        input.localDate,
        input.maxStartsPerDay,
      );
    // 「押さえられなかった」と「もう押さえてある」は結果が正反対なので、
    // changesだけでは決められない。同じトランザクションで行を読み直す。
    const read = this.db
      .prepare(
        `SELECT started_at,
                status,
                COALESCE(max_seconds, ${legacySessionMaxSeconds}) AS max_seconds,
                (SELECT COUNT(*) FROM sessions AS counted
                  WHERE counted.device_id = sessions.device_id
                    AND counted.local_date = ?
                    AND counted.started_at IS NOT NULL) AS sessions_today,
                COALESCE((
                  SELECT SUM(
                    CASE
                      WHEN counted.duration_seconds IS NOT NULL THEN counted.duration_seconds
                      ELSE COALESCE(counted.max_seconds, ${legacySessionMaxSeconds})
                    END
                  )
                  FROM sessions AS counted
                  WHERE counted.device_id = sessions.device_id
                    AND counted.local_date = ?
                    AND counted.started_at IS NOT NULL
                ), 0) AS consumed_seconds
           FROM sessions
          WHERE id = ? AND device_id = ?`,
      )
      .bind(input.localDate, input.localDate, input.sessionId, input.deviceId);

    const results = await this.db.batch<{
      started_at: string | null;
      status: SessionRecord["status"];
      max_seconds: number;
      sessions_today: number;
      consumed_seconds: number;
    }>([start, read]);
    const startResult = results[0];
    if (!startResult) throw new Error("授業枠のUPDATE結果がありません");
    const changes = changesOf(startResult.meta);

    const row = results[1]?.results[0];
    if (!row) return { started: false };
    const startedResult = {
      started: true as const,
      maxSeconds: row.max_seconds,
      sessionsToday: row.sessions_today,
      remainingSecondsToday: Math.max(0, input.secondsPerDay - row.consumed_seconds),
    };
    if (changes > 0) return { ...startedResult, alreadyStarted: false };
    // 更新できなかったのに始まっている = 前に押さえた枠がそのまま生きている。
    if (row.started_at !== null && row.status === "open") {
      return { ...startedResult, alreadyStarted: true };
    }
    return { started: false };
  }

  async reserveSessionAnalysis(input: {
    sessionId: string;
    deviceId: string;
    localDate: string;
    maxAnalysesPerSession: number;
    maxAnalysesPerDay: number;
  }): Promise<boolean> {
    /**
     * 上限確認と加算を同じUPDATEにする。SQLiteは1文の書き込みを直列化するので、
     * 同時に2枚届いても、セッション5回と既存の日次解析枠のどちらも越えない。
     */
    const result = await this.db
      .prepare(
        `UPDATE sessions
            SET analysis_count = analysis_count + 1
          WHERE id = ?
            AND device_id = ?
            AND kind = 'new'
            AND status = 'open'
            AND started_at IS NOT NULL
            AND analysis_count < ?
            AND (SELECT COALESCE(SUM(analysis_count), 0) FROM sessions
                  WHERE device_id = ? AND local_date = ?) < ?`,
      )
      .bind(
        input.sessionId,
        input.deviceId,
        input.maxAnalysesPerSession,
        input.deviceId,
        input.localDate,
        input.maxAnalysesPerDay,
      )
      .run();
    return changesOf(result.meta) > 0;
  }

  async releaseSessionAnalysis(sessionId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions
            SET analysis_count = MAX(1, analysis_count - 1)
          WHERE id = ?`,
      )
      .bind(sessionId)
      .run();
  }

  async updateSessionContextIfRevision(input: {
    sessionId: string;
    expectedRevision: number;
    topicIds: string[];
    context: SessionContext;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions
            SET topic_ids = ?, context = ?
          WHERE id = ?
            AND status = 'open'
            AND COALESCE(json_extract(context, '$.revision'), 1) = ?`,
      )
      .bind(
        JSON.stringify(input.topicIds),
        JSON.stringify(input.context),
        input.sessionId,
        input.expectedRevision,
      )
      .run();
    return changesOf(result.meta) > 0;
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
        `UPDATE sessions
            SET status = 'completed', completed_at = ?, duration_seconds = ?, quota_settled_at = ?
          WHERE id = ?`,
      )
      .bind(input.completedAt, input.durationSeconds, input.completedAt, input.sessionId)
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
     * 保存と完了印が別々に成功すると、再送時に「完了済みだが計画が無い」か
     * 「計画は変わったがセッションはopen」が生まれる。D1 batch の原子性で2文を束ね、
     * 先に完了した再送では1文目の SELECT が0件になって現行計画を上書きしない。
     * また初回の部屋が二重に開かれ、別々のplan idで同時にcompleteされても、後着の
     * UPSERTはWHEREで更新を拒む。既存idを差し替えると、先着セッションの外部キーが
     * 切れるだけでなく「同じ計画を組み直した」という履歴の連続性まで失うため。
     * finish側は実際に端末へ保存されたidを引き直し、後着セッションも安全に閉じる。
     */
    const results = await this.db.batch([save, finish]);
    const saveResult = results[0];
    if (!saveResult) throw new Error("計画の保存結果がありません");
    return changesOf(saveResult.meta) > 0;
  }
}

/** metaの形が変わったとき、全員を上限到達として黙って止めずに異常を表へ出す。 */
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

/**
 * JSON列を個別に型アサーションすると、壊れた行がAPIレスポンスまで抜ける。
 * 保存後の計画は将来の親レポートも読む一次データなので、契約全体で検証してから返す。
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
