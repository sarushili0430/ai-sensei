import type {
  HoleSeverity,
  Locale,
  PracticeVerdict,
  ProblemOutcome,
  SessionProblem,
  StudyPlan,
} from "@ai-sensei/contract";

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
/** 1問ぶんの解析結果。問題写真そのものは含めない(解析後に破棄するため)。 */
export type SessionMaterialContext = {
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
  /**
   * {@link problem} が `null` になった理由(読めたときは `"read"`)。
   *
   * **確認画面が「次の一手」を出すために要る。** 紙面を丸ごと撮っているのか、
   * 解答まで写っているのかで、生徒に言うことが変わる。ここに残していないと、
   * 単元を絞り込んだ瞬間(PATCH /topics)に理由だけが消え、同じ画面が
   * 「読み取れませんでした」しか言えなくなる。
   *
   * 写真を読んでいないセッション(復習)と、この欄が無い古い行では `undefined`。
   * 呼び出し側は `?? null` で受けること。
   */
  problem_outcome?: ProblemOutcome | null;
  visible_work: string[];
  question_seeds: string[];
  /** 検出時の確信度。チップUIの表示を、単元を絞ったあとも同じに保つ。 */
  topics: { topic_id: string; confidence: number }[];
  /** この問題にノート写真があったか。追加の問題写真だけなら false。 */
  has_notes_photo?: boolean;
};

export type SessionContext = SessionMaterialContext & {
  /**
   * 会話中の差し替え版。初期解析を1とし、問題を足すたび1つ進める。
   * 古い行には無いので省略可能。読む側は1として扱う。
   */
  revision?: number;
  /**
   * セッションで扱った問題の列。カルテはセッション1本のままなので、過去の問題を
   * 捨てずに追記する。一方、上の直下フィールドは「いま教える問題」を指す。
   */
  materials?: SessionMaterialContext[];
};

export type SessionRecord = {
  id: string;
  device_id: string;
  kind: "new" | "review";
  status: "open" | "completed";
  created_at: string;
  completed_at: string | null;
  /**
   * 数える日。**会話が始まった時点で、その日へ書き直される**(`startSession`)。
   *
   * 解析だけして日付をまたいだセッションを、撮った日のほうへ数えないため。
   * streakと親レポートの月境界も同じ列を見ているので、「授業をした日」の
   * 定義が3か所で揃う。
   */
  local_date: string;
  photo_key: string | null;
  topic_ids: string[];
  /** @deprecated 穴起点の復習。移行が終わるまで残す(ADR 0009)。 */
  hole_id: string | null;
  /** 復習で教え直す復習問題。新規授業では null。 */
  practice_problem_id: string | null;
  duration_seconds: number | null;
  /** 解析前・復習セッションでは null。 */
  context: SessionContext | null;
  /**
   * 会話が始まった時刻。まだ始まっていなければ null。
   *
   * **日次の持ち時間と開始回数ガードはこの列を起点に数える。** 行が在ることではない —
   * 写真を読んだだけのセッションは行にはなるが、先輩とは1度も話していない。
   */
  started_at: string | null;
  /**
   * `/start` がその回に仮押さえした秒数。開始前は null。
   * 旧データの null は、従来の1回上限1200秒として読む。
   */
  max_seconds: number | null;
  /**
   * 日次の持ち時間を実績へ精算した時刻。
   * `/complete` が来ない回も、トークンの寿命を過ぎたら仮押さえ額で埋める。
   */
  quota_settled_at: string | null;
  /** 初回解析を含む、このセッションで使った解析枠。 */
  analysis_count: number;
};

/**
 * `max_seconds` を保存していなかった旧セッションの復元値。
 * 移行前の1回上限が無料・Premiumとも1200秒だったため。
 */
export const legacySessionMaxSeconds = 1200;

export type DailySessionUsage = {
  /** 完了は実績、進行中は仮押さえを合計した秒数。 */
  consumedSeconds: number;
  /** 異常利用ガードのための開始回数。 */
  sessionsStarted: number;
};

/**
 * 日次の持ち時間を確保した結果。
 * **使用量を読んでから別操作で書くのではなく、書けたかどうかで判定する。**
 *
 * `started` を返すのは、呼び出し側に「まだ空いているか」を判断させないため。
 * 使用量を返して再判定させると、読み取りと書き込みを分ける実装へ戻れてしまう。
 */
export type SessionStartResult =
  | {
      started: true;
      /**
       * 押さえたのは今回ではなく、前に押さえた時間のまま。
       *
       * 通信が切れて押し直したとき、同じセッションの2度目をここで区別する。
       * 二重に確保しないための印で、呼び出し側はトークンだけ出し直せばよい。
       */
      alreadyStarted: boolean;
      /**
       * 押さえた分を含む、その日の開始回数。
       *
       * 上限の判定には使わない(判定はもう終わっている)。`lesson_allowed_today` =
       * 「今日もう一度始められるか」を組み立てるためだけの値。
       */
      sessionsToday: number;
      /** このセッションに原子的に確保できた秒数。 */
      maxSeconds: number;
      /** 今回の仮押さえ後に残っている当日の秒数。 */
      remainingSecondsToday: number;
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
 * 復習問題(ADR 0009)。**穴とは別の行として持つ。**
 *
 * `answer` はここにしか無く、アプリへは返らない。採点(`POST /v1/me/practice/{id}`)が
 * 突き合わせるためだけの欄で、結果画面に出すと「先輩に聞く」の導線が死ぬ。
 */
export type PracticeProblemRecord = {
  id: string;
  device_id: string;
  session_id: string;
  /** 材料になった板書。誤った問題の原因を追う唯一の手段。 */
  board_id: string;
  topic_id: string;
  question: string;
  answer: string;
  created_at: string;
};

/** 1回ぶんの解答と採点。**合否に関わらず積む**(消えるのは通知の段だけ)。 */
export type PracticeAttemptRecord = {
  id: string;
  problem_id: string;
  answered_at: string;
  response: string;
  verdict: PracticeVerdict;
  graded_by: string;
  comment: string | null;
};

/**
 * 復習問題の通知予約。
 *
 * `ReviewScheduleRecord` と別なのは、あちらの `hole_id` が NOT NULL + 外部キーで、
 * SQLite では制約を緩めるのにテーブルの作り直しが要るため(migration 0011)。
 */
export type PracticeScheduleRecord = {
  id: string;
  problem_id: string;
  step: 1 | 2 | 3;
  scheduled_at: string;
  external_id: string | null;
};

/**
 * 計画を作るための音声セッション。授業セッションとは別の寿命・集計で持つ。
 *
 * 計画を `sessions` に混ぜると、計画を組み直した日まで連続学習日に数えられ、
 * 「授業をした日」という親への説明が嘘になる。LiveKitを使う点だけは同じでも、
 * プロダクト上の出来事は別なのでレコードも分ける。
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
   * 当日の使用済み時間。完了は `duration_seconds`、進行中は `max_seconds`を数える。
   * 表示と事前案内用で、確保の判定は必ず {@link Repository.startSession} の1操作で行う。
   */
  getDailySessionUsage(deviceId: string, localDate: string): Promise<DailySessionUsage>;
  /**
   * `/complete` が来ない開始済みセッションを、仮押さえ額で自動精算する。
   * 壊れた `started_at` も再入室できないので、漏れを避ける側へ倒す。
   * 会話実績やカルテは無いので `status` は completed にせず、streakには混ぜない。
   */
  settleExpiredSessions(input: {
    deviceId: string;
    now: string;
    graceSeconds: number;
  }): Promise<number>;
  /**
   * セッション行を作る道はこの操作だけにする。上限の確認と作成を分ける道を残すと、
   * 将来また「数えてから入れる」が書けてしまうため。
   *
   * **ここで押さえるのは持ち時間ではなく、写真解析の枠。** 持ち時間は
   * {@link Repository.startSession} が会話の開始時に押さえる。この上限は
   * 想定する授業本数よりずっと緩く、解析だけを延々と繰り返してVisionの原価を
   * 積む使い方だけを止める。
   */
  createSession(input: {
    session: SessionRecord;
    /** その日に許す解析の本数。 */
    maxAnalysesPerDay: number;
  }): Promise<boolean>;
  /**
   * 会話の開始。**持ち時間の確保とこの記録は1操作**にする。
   *
   * 分けて書くと、同時に始めた2本が同じ「まだ空いている」を見て両方通る。
   * `localDate` も一緒に書き直すのは、数える日を「会話が始まった日」に
   * 揃えるため({@link SessionRecord.local_date})。
   */
  startSession(input: {
    sessionId: string;
    deviceId: string;
    startedAt: string;
    localDate: string;
    /** その日に使える合計秒数。 */
    secondsPerDay: number;
    /** 1回の最長秒数。残高のほうが小さければそちらを確保する。 */
    sessionMaxSeconds: number;
    /** これ未満の残高では、締めまで成立しないので始めない。 */
    minimumSessionSeconds: number;
    /** 持ち時間とは別の、1日の開始連打ガード。 */
    maxStartsPerDay: number;
  }): Promise<SessionStartResult>;
  /**
   * 会話中の追加解析枠を条件付きで1つ押さえる。同時押しでも上限を越えない1操作。
   */
  reserveSessionAnalysis(input: {
    sessionId: string;
    deviceId: string;
    localDate: string;
    maxAnalysesPerSession: number;
    maxAnalysesPerDay: number;
  }): Promise<boolean>;
  /** 写真を読めず解析が成立しなかったとき、押さえた追加枠を返す。 */
  releaseSessionAnalysis(sessionId: string): Promise<void>;
  /**
   * 追加解析の結果を、読んだrevisionがまだ最新のときだけ書き戻す。
   * falseなら呼び出し側は最新を読み直してマージし、同時更新を取りこぼさない。
   */
  updateSessionContextIfRevision(input: {
    sessionId: string;
    expectedRevision: number;
    topicIds: string[];
    context: SessionContext;
  }): Promise<boolean>;
  /** 写真解析のあとに、確定した単元と写真キー、会話の文脈を書き戻す。 */
  updateSessionTopics(input: {
    sessionId: string;
    topicIds: string[];
    photoKey: string | null;
    context: SessionContext | null;
  }): Promise<void>;
  /** 解析に失敗したときに予約を取り消す(解析枠を無駄に消費させないため)。 */
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

  /**
   * 復習問題を保存する。**1セッションにつき1問**(ADR 0009)。
   *
   * 通知が問題ごとに飛ぶので、1セッションで6通になりうる形にはしない。
   * 増やすのは実際に届く数を見てから。
   */
  insertPracticeProblem(problem: PracticeProblemRecord): Promise<void>;
  getPracticeProblem(problemId: string): Promise<PracticeProblemRecord | null>;
  /**
   * そのセッションで作った問題。**`/complete` の再送判定がこれを見る。**
   *
   * agent はタイムアウトで再送してくるので、素通しすると問題も通知も二重にできる
   * (旧経路では `getKarteBySession` が同じ役目を持っていた)。
   */
  getPracticeProblemBySession(sessionId: string): Promise<PracticeProblemRecord | null>;
  /** 古い順。復習リストの並びは「放置されたものから声をかける」。 */
  listPracticeProblems(deviceId: string): Promise<PracticeProblemRecord[]>;
  /**
   * そのデバイスの解答履歴(古い順)。問題を跨いで読むので、進捗の集計と
   * 「その問題の直近の判定」の両方がこれ1本で足りる。
   */
  listPracticeAttempts(deviceId: string): Promise<PracticeAttemptRecord[]>;
  insertPracticeAttempt(attempt: PracticeAttemptRecord): Promise<void>;
  /**
   * 通知の予約を足す。**取り消す口は作らない。**
   *
   * 作成時に決めた段は取り消さない(ADR 0009)。取り消せる形にすると、
   * 「正解したから残りを消す」が書けてしまい「1回言えたら終わり」に戻る。
   */
  insertPracticeSchedules(entries: PracticeScheduleRecord[]): Promise<void>;
  /** その問題に予約済みの通知。二重予約の検知と、画面に出す次回日の元になる。 */
  listPracticeSchedules(problemId: string): Promise<PracticeScheduleRecord[]>;

  /** 計画セッションには日次の授業枠を使わない。Premium判定はルート側で行う。 */
  createPlanSession(session: PlanSessionRecord): Promise<void>;
  getPlanSession(planSessionId: string): Promise<PlanSessionRecord | null>;
  /** 組み直し前の事実を音声セッションへ渡すため、ユーザーごとの現行計画を読む。 */
  getCurrentPlan(deviceId: string): Promise<StudyPlan | null>;
  /** complete の再送では、そのセッションが実際に保存した計画を返す。 */
  getPlan(planId: string): Promise<StudyPlan | null>;
  /**
   * 計画の置換とセッション完了を同じ原子的操作にする。
   * false は別の同時リクエストが先に完了したという意味で、呼び出し側は保存済みを返す。
   */
  completePlanSession(input: {
    sessionId: string;
    completedAt: string;
    durationSeconds: number;
    plan: StudyPlan;
  }): Promise<boolean>;
};
