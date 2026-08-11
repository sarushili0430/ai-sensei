import type { HoleSeverity, SessionProblem } from "@ai-sensei/contract";

export type UserRecord = {
  device_id: string;
  created_at: string;
  is_premium: boolean;
  premium_expires_at: string | null;
  rc_app_user_id: string | null;
};

/**
 * 会話の文脈。LiveKitトークンの metadata に載せる分だけを持つ。
 *
 * 単元を絞り込んだあとにトークンを出し直すとき、写真をもう一度
 * 解析しないで済むように、解析の結果をセッションに残しておく。
 */
export type SessionContext = {
  summary: string;
  /**
   * 解析が読み取った問題。読めなければ null。
   *
   * **写真そのものは残らないので、ここが問題文の唯一の保存先。**
   * 問題の写真は解析後に破棄する(著作物。`contract` の `sessionPhotoParts`)ので、
   * ここを落とすと、単元を絞り込んだ瞬間(PATCH /topics)に問題文が消え、
   * 先輩が問題を見ないまま教え始める状態に戻る。
   *
   * D1では `context` 列にJSONで入る(列は増えないのでマイグレーション不要)。
   * この欄が無い古い行は `undefined` で読めるので、`?? null` で受けること。
   */
  problem?: SessionProblem | null;
  visible_work: string[];
  question_seeds: string[];
  /** 検出時の確信度。チップUIの表示を、単元を絞ったあとも同じに保つ。 */
  topics: { topic_id: string; confidence: number }[];
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
  /** 解析前・復習セッションでは null。 */
  context: SessionContext | null;
};

/**
 * 授業枠の確保の結果。**数えてから入れるのではなく、入れられたかどうかで判定する。**
 *
 * 数えた件数ではなく `reserved` を返すのは、呼び出し側に「まだ空いているか」を
 * 判断させないため。件数を渡すと、そこからもう一度上限と比べる書き方に戻れてしまう。
 */
export type SessionReservation =
  | {
      reserved: true;
      /**
       * 押さえた分を含む、その日の本数。
       *
       * 上限の判定には使わない(判定はもう終わっている)。`lesson_allowed_today` =
       * 「今日もう一度始められるか」を組み立てるためだけの値。
       */
      sessionsToday: number;
    }
  | { reserved: false };

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

  /**
   * 表示用。枠の判定には使わないこと。数えてから入れると、同時実行が同じ件数を見て上限を抜ける。
   */
  countSessionsOnDate(deviceId: string, localDate: string): Promise<number>;
  /**
   * セッション行を作る道はこの操作だけにする。枠の確認と作成を分ける道を残すと、
   * 将来また「数えてから入れる」が書けてしまうため。
   */
  reserveSessionSlot(input: {
    session: SessionRecord;
    /** その日に許す本数(無料1 / Premium 3)。 */
    maxPerDay: number;
  }): Promise<SessionReservation>;
  /** 写真解析のあとに、確定した単元と写真キー、会話の文脈を書き戻す。 */
  updateSessionTopics(input: {
    sessionId: string;
    topicIds: string[];
    photoKey: string | null;
    context: SessionContext | null;
  }): Promise<void>;
  /** 解析に失敗したときに予約を取り消す(無料枠を無駄に消費させないため)。 */
  deleteSession(sessionId: string): Promise<void>;
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
  /** セッションに紐づくカルテ。/complete の再送判定と、アプリの結果取得に使う。 */
  getKarteBySession(sessionId: string): Promise<{ karte: KarteRecord; holes: HoleRecord[] } | null>;

  /**
   * 親レポートに載せる期間のカルテ。
   * `created_at` のUTC日付ではなくセッションの `local_date` で絞る。月初の深夜に
   * 作ったカルテを前月へ落とすと、ホームのstreakと親レポートで日付が食い違うため。
   */
  listKartesOnLocalDates(input: {
    deviceId: string;
    fromDate: string;
    toDate: string;
  }): Promise<KarteRecord[]>;

  listHoles(deviceId: string): Promise<HoleRecord[]>;
  getHole(holeId: string): Promise<HoleRecord | null>;
  /** open → filled の最初の更新だけを反映する。再送で filled_at を動かさない。 */
  markHoleFilled(holeId: string, filledAt: string): Promise<void>;

  insertReviewSchedules(entries: ReviewScheduleRecord[]): Promise<void>;
  cancelReviewSchedules(holeId: string): Promise<ReviewScheduleRecord[]>;
};
