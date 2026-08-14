import type { HoleSeverity, Locale, SessionProblem, StudyPlan } from "@ai-sensei/contract";

export type UserRecord = {
  device_id: string;
  created_at: string;
  is_premium: boolean;
  premium_expires_at: string | null;
  rc_app_user_id: string | null;
};

/**
 * The conversation context. Holds only what goes into the LiveKit token metadata.
 *
 * The analysis result is kept on the session so that reissuing a token after
 * narrowing the unit does not re-analyse the photo.
 */
export type SessionContext = {
  summary: string;
  /**
   * The problem the analysis read. null if unreadable.
   *
   * The photo itself is not kept, so this is the only home for the problem text.
   * The problem photo is discarded after analysis (copyrighted work; `contract`'s
   * `sessionPhotoParts`), so dropping this would erase the problem text the
   * moment the unit is narrowed (PATCH /topics), returning to a senpai who
   * teaches without seeing the problem.
   *
   * In D1 it lives as JSON in the `context` column (no new column, no migration).
   * Old rows without this field read as `undefined`, so receive it with `?? null`.
   */
  problem?: SessionProblem | null;
  visible_work: string[];
  question_seeds: string[];
  /** Confidence at detection time. Keeps the chip UI identical after narrowing. */
  topics: { topic_id: string; confidence: number }[];
};

export type SessionRecord = {
  id: string;
  device_id: string;
  kind: "new" | "review";
  status: "open" | "completed";
  created_at: string;
  completed_at: string | null;
  /**
   * The day counted. Rewritten to the day the conversation started (`startSession`).
   *
   * So a session analysed before midnight is not counted on the day of the photo.
   * Streaks and the parent report's month boundary read the same column, so
   * "a day with a lesson" means the same thing in all three places.
   */
  local_date: string;
  photo_key: string | null;
  topic_ids: string[];
  hole_id: string | null;
  duration_seconds: number | null;
  /** null before analysis and for review sessions. */
  context: SessionContext | null;
  /**
   * When the conversation started; null if it has not.
   *
   * The daily count comes from this column, not from the row existing - a session
   * that only read a photo has a row but never spoke to the senpai.
   */
  started_at: string | null;
};

/**
 * The result of claiming a lesson slot (= the right to one conversation).
 * Not "count, then insert" but "decide from whether the insert succeeded".
 *
 * It returns `started` rather than a count so the caller never judges "is there
 * room left". Handing over a count invites rewriting the comparison against the
 * cap all over again.
 */
export type SessionStartResult =
  | {
      started: true;
      /**
       * The slot held is the one claimed earlier, not one claimed now.
       *
       * On a reconnect and retry, this distinguishes the second attempt at the
       * same session. It marks "do not count twice"; the caller need only reissue
       * the token.
       */
      alreadyStarted: boolean;
      /**
       * The day's count, including the one just claimed.
       *
       * Not used for the cap check (that is already done). Only for assembling
       * `lesson_allowed_today` = "can another be started today".
       */
      sessionsToday: number;
    }
  | { started: false };

export type HoleRecord = {
  id: string;
  device_id: string;
  karte_id: string;
  topic_id: string;
  desc: string;
  severity: HoleSeverity;
  evidence: string | null;
  quiz: string | null;
  status: "open" | "filled";
  created_at: string;
  filled_at: string | null;
};

export type KarteRecord = {
  id: string;
  session_id: string;
  device_id: string;
  created_at: string;
  topic_ids: string[];
  said_well: string[];
  term_notes: string[];
  followup_question: string | null;
};

export type ReviewScheduleRecord = {
  id: string;
  hole_id: string;
  step: 1 | 2 | 3;
  scheduled_at: string;
  external_id: string | null;
};

/**
 * A voice session for building a plan. Separate lifetime and accounting from a
 * lesson session.
 *
 * Mixing plans into `sessions` would count the day a plan was rebuilt as a study
 * day, making the streak we report to parents a lie. They share LiveKit, but as
 * product events they are different, so the records are separate too.
 */
export type PlanSessionRecord = {
  id: string;
  device_id: string;
  locale: Locale;
  status: "open" | "completed";
  created_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  plan_id: string | null;
};

/**
 * The persistence boundary.
 *
 * Routes depend only on this interface: D1 in production, an in-memory
 * implementation in tests. Without it, testing free-tier checks or streak
 * counting would mean spinning up miniflare every time.
 */
export type Repository = {
  ensureUser(deviceId: string, now: Date): Promise<UserRecord>;
  getUser(deviceId: string): Promise<UserRecord | null>;
  setPremium(input: {
    deviceId: string;
    isPremium: boolean;
    expiresAt: string | null;
    rcAppUserId: string | null;
  }): Promise<void>;

  /**
   * How many sessions *started a conversation* that day.
   *
   * For display and advance notice only; never for the slot check. Counting then
   * inserting lets concurrent requests read the same count and slip past the cap.
   */
  countStartedSessionsOnDate(deviceId: string, localDate: string): Promise<number>;
  /**
   * The only way to create a session row. Leaving a path that separates the cap
   * check from creation would let "count, then insert" be written again.
   *
   * What is claimed here is the photo-analysis slot, not the lesson slot. The
   * lesson slot is claimed by {@link Repository.startSession} at conversation
   * start. This cap is far looser than the daily lesson count and stops only
   * endless analysis that racks up Vision costs.
   */
  createSession(input: {
    session: SessionRecord;
    /** How many analyses to allow that day. */
    maxAnalysesPerDay: number;
  }): Promise<boolean>;
  /**
   * Conversation start. Claiming the lesson slot and writing this record are one
   * operation.
   *
   * Written separately, two conversations starting at once both see the same
   * "still room" and both pass. `localDate` is rewritten at the same time so the
   * counted day matches the day the conversation started
   * ({@link SessionRecord.local_date}).
   */
  startSession(input: {
    sessionId: string;
    deviceId: string;
    startedAt: string;
    localDate: string;
    /** How many lessons to allow that day (free 1 / Premium 3). */
    maxPerDay: number;
  }): Promise<SessionStartResult>;
  /** After photo analysis, writes back the settled units, photo key and conversation context. */
  updateSessionTopics(input: {
    sessionId: string;
    topicIds: string[];
    photoKey: string | null;
    context: SessionContext | null;
  }): Promise<void>;
  /** Cancels the reservation when analysis fails (so the free slot is not wasted). */
  deleteSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  completeSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
  }): Promise<void>;
  /** Local dates of completed sessions (used for the streak). */
  sessionDates(deviceId: string): Promise<string[]>;

  insertKarte(karte: KarteRecord, holes: HoleRecord[]): Promise<void>;
  getKarte(karteId: string): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null>;
  /** The karte for a session. Used for /complete resend checks and the app's result fetch. */
  getKarteBySession(sessionId: string): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null>;

  /**
   * Kartes for the parent report's period.
   * Filtered by the session's `local_date`, not `created_at`'s UTC date. Pushing a
   * karte made late on the 1st into the previous month would make the home streak
   * and the parent report disagree on dates.
   */
  listKartesOnLocalDates(input: {
    deviceId: string;
    fromDate: string;
    toDate: string;
  }): Promise<KarteRecord[]>;

  listHoles(deviceId: string): Promise<HoleRecord[]>;
  getHole(holeId: string): Promise<HoleRecord | null>;
  /** Applies only the first open -> filled update. A resend must not move filled_at. */
  markHoleFilled(holeId: string, filledAt: string): Promise<void>;

  insertReviewSchedules(entries: ReviewScheduleRecord[]): Promise<void>;
  cancelReviewSchedules(holeId: string): Promise<ReviewScheduleRecord[]>;

  /** Plan sessions do not use the daily lesson slot. The Premium check is done in the route. */
  createPlanSession(session: PlanSessionRecord): Promise<void>;
  getPlanSession(planSessionId: string): Promise<PlanSessionRecord | null>;
  /** Reads the user's current plan, to hand the pre-rebuild facts to the voice session. */
  getCurrentPlan(deviceId: string): Promise<StudyPlan | null>;
  /** On a complete resend, returns the plan that session actually saved. */
  getPlan(planId: string): Promise<StudyPlan | null>;
  /**
   * Makes replacing the plan and completing the session one atomic operation.
   * false means another concurrent request finished first, and the caller returns
   * what is already stored.
   */
  completePlanSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
    plan: StudyPlan;
  }): Promise<boolean>;
};
