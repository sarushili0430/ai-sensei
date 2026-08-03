import type { HoleSeverity } from "@ai-sensei/contract";

export type UserRecord = {
  device_id: string;
  created_at: string;
  is_premium: boolean;
  premium_expires_at: string | null;
  rc_app_user_id: string | null;
};

export type SessionRecord = {
  id: string;
  device_id: string;
  kind: "new" | "review";
  status: "open" | "completed";
  created_at: string;
  completed_at: string | null;
  local_date: string;
  photo_key: string | null;
  topic_ids: string[];
  hole_id: string | null;
  duration_seconds: number | null;
};

export type HoleRecord = {
  id: string;
  device_id: string;
  karte_id: string;
  topic_id: string;
  desc: string;
  severity: HoleSeverity;
  evidence: string | null;
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
 * 永続化の境界。
 *
 * ルートはこのインターフェースにだけ依存する。本番はD1、テストはメモリ実装。
 * こうしておかないと、無料枠の判定やstreakの数え方をテストするたびに
 * miniflareを起こす羽目になる。
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

  countSessionsOnDate(deviceId: string, localDate: string): Promise<number>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  completeSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
  }): Promise<void>;
  /** 完了済みセッションのローカル日付一覧(streakの計算に使う)。 */
  sessionDates(deviceId: string): Promise<string[]>;

  insertKarte(karte: KarteRecord, holes: HoleRecord[]): Promise<void>;
  getKarte(karteId: string): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null>;

  listHoles(deviceId: string): Promise<HoleRecord[]>;
  getHole(holeId: string): Promise<HoleRecord | null>;
  markHoleFilled(holeId: string, filledAt: string): Promise<void>;

  insertReviewSchedules(entries: ReviewScheduleRecord[]): Promise<void>;
  cancelReviewSchedules(holeId: string): Promise<ReviewScheduleRecord[]>;
};
