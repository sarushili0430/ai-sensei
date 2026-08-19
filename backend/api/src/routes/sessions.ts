import {
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ProblemOutcome,
  type SessionMetadata,
  type SessionProblem,
  type StartSessionResponse,
  type UpdateSessionProblemResponse,
  type UpdateSessionTopicsResponse,
  createSessionRequestSchema,
  problemTextMaxLength,
  sessionMetadataSchema,
  sessionPhotoParts,
  startSessionRequestSchema,
  updateSessionProblemRequestSchema,
  updateSessionTopicsRequestSchema,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import {
  type AllowedTopics,
  allowedTopicList,
  allowedTopicsLocale,
  buildAllowedTopics,
  checkProblemText,
  toLocalDate,
} from "@ai-sensei/guardrail";
import {
  formatAllowedTopics,
  formatBullets,
  formatProblemText,
  formatVisibleWork,
} from "@ai-sensei/prompts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Bindings } from "../env.ts";
import { readLimits } from "../env.ts";
import {
  analysesPerDay,
  canReissueToken,
  canStartSessionToday,
  hasPremiumAccess,
  limitReachedAllowance,
  maxSessionStartsPerDay,
  minimumSessionSeconds,
  secondsPerDay,
  sessionMaxSeconds,
  startedAllowance,
  tokenGraceSeconds,
} from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import { type AgentDispatch, createLiveKitToken } from "../lib/livekit.ts";
import {
  type PhotoAnalysis,
  type PhotoAnalysisImage,
  detectImageMediaType,
  resolveDetectedTopics,
  resolveSessionProblem,
  toDetectedTopicPayload,
} from "../lib/photo-analysis.ts";
import type { HoleRecord, SessionContext } from "../repository/types.ts";

export const sessionsRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions
 *
 * 写真を受け取り、Vision LLMで単元を判定して、**単元と問題文の読み合わせだけ**を返す。
 * ここで作った許可トピックが、会話中のガードレールの基準になる。
 *
 * **ここでは日次の持ち時間を押さえない。** 押さえるのは会話が始まったとき
 * (`POST /v1/sessions/{id}/start`)。撮って単元を確かめただけで枠が消え、
 * 先輩と1度も話さないまま「今日はここまで」になっていたのを直したもの。
 *
 * 数えないかわりに、この入口には2つの門がある:
 *
 *   1. **もう今日の授業を使い切っていないか**(下の事前判定)。使い切った人に
 *      Vision LLMを回してから断るのは、原価の面でも体験の面でも損しかない
 *   2. **解析そのものの上限**(`analysesPerDay`)。想定する授業本数よりずっと緩く、
 *      解析だけを延々と繰り返す使い方だけを止める
 */
sessionsRoute.post("/", async (c) => {
  const { repository, analyzer, now, newId } = c.get("services");
  const log = c.get("log");
  const deviceId = c.get("deviceId");
  const at = now();
  const limits = readLimits(c.env);

  const form = await c.req.formData();
  const meta = parseMeta(form.get("meta"));
  /** アプリの表示言語。エラー文言はこれで返す。 */
  const locale = meta.locale;

  const user = await repository.ensureUser(deviceId, at);
  /**
   * 事実: toLocalDateの既定はJST固定(+540分)で、クライアントの申告ではなく
   * サーバが受信時刻から作る。同じ瞬間に届いた2本は必ず同じlocal_dateになり、
   * 上限の判定の鍵がリクエストごとにぶれることはない。
   *
   * 判断: ずれ得るのはJSTの日付境界をまたぐ数ミリ秒だけで、その2本は本当に別の日に属する。
   * 反対に、クライアント申告からlocal_dateを作った瞬間、日付を1つずらすだけで新しい枠が生え、
   * この上限は無力になる。
   *
   * 将来ユーザーのタイムゾーンに追随するなら、オフセットの出どころをサーバが決めることを
   * 前提にし、getDailySessionUsageの表示と枠の判定を同じ日付規則へ一緒に動かす。
   */
  const localDate = toLocalDate(at);

  // 無料なのは `/v1/me/reviews` の10秒小テストまで。ここから先はLiveKit・
  // STT・LLM・TTSを起動して板書つきで教え直す授業なので、通常の授業と同じ
  // Premium境界に戻る。画面だけで止めても `hole_id` を直接送れば迂回できるため、
  // サーバ側で判定する。**従量原価が動くのは `/start` なので、そちらでも見る** —
  // ここは、始める前に断るための早い門。
  if (meta.kind === "review" && !hasPremiumAccess({ user, now: at, limits })) {
    throw apiError("premium_required", { locale });
  }

  // 復習セッションは写真を使わず、対象の穴から単元を引く。
  // 他人の穴IDを渡されても動かないよう、所有者をここで確かめる。
  let reviewHole: HoleRecord | null = null;
  if (meta.kind === "review") {
    reviewHole = meta.hole_id ? await repository.getHole(meta.hole_id) : null;
    if (!reviewHole || reviewHole.device_id !== deviceId) {
      throw apiError("session_not_found", { locale });
    }
  }

  /**
   * 今日はもう授業を始められない人を、写真を読む前に止める。
   *
   * **これは枠の確保ではない**(確保は `/start` の1操作)。ここで数えて、
   * 始めるときにもう一度数えるので、その隙間に別の1本が始まることはありうる。
   * それでも構わない — 隙間で起きるのは「解析まで進めたのに始められない」で、
   * 上限そのものは `/start` が守る。ここを消すと、使い切った人にも毎回
   * Vision LLMを回してから断ることになる。
   */
  await repository.settleExpiredSessions({
    deviceId,
    now: at.toISOString(),
    graceSeconds: tokenGraceSeconds,
  });
  const usage = await repository.getDailySessionUsage(deviceId, localDate);
  const remainingSecondsToday = Math.max(
    0,
    secondsPerDay({ user, now: at, limits }) - usage.consumedSeconds,
  );
  if (
    !canStartSessionToday({
      remainingSecondsToday,
      sessionsToday: usage.sessionsStarted,
    })
  ) {
    const limitReached = limitReachedAllowance({ user, now: at, limits });
    throw apiError(limitReached.reason, {
      locale,
      retryAfterSeconds: limitReached.retryAfterSeconds,
    });
  }

  const photo = form.get(sessionPhotoParts.notes);
  /**
   * 問題の写真。これは教科書・問題集の紙面 = 著作物なので、**R2に入れない。**
   */
  const problemPhoto = form.get(sessionPhotoParts.problem);

  /**
   * `kind: "new"` に要るのは**どちらか1枚**。両方無いときだけ弾く。
   *
   * **ノートを必須にしていた頃、この行が破棄の約束を破っていた。**
   * ノートが無い生徒には紙面を `photo` 枠に入れる以外の道が無く、
   * 結果として他者の著作物がR2に保存されていた(理由の全文は
   * `contract` の `sessionPhotoParts`)。
   */
  if (meta.kind === "new" && !(photo instanceof File) && !(problemPhoto instanceof File)) {
    throw apiError("photo_unreadable", { locale });
  }

  const sessionId = newId("ses");

  // 条件付きINSERTが上限の確認と行の作成を1操作で行うため、同時投稿も同じ枠を取れない。
  // ここで押さえるのは**解析の枠**(授業の枠は `/start`)。写真のアップロードと解析より
  // 先に押さえ、解析に失敗したら下で行ごと消して枠を返す。
  const created = await repository.createSession({
    session: {
      id: sessionId,
      device_id: deviceId,
      kind: meta.kind,
      status: "open",
      created_at: at.toISOString(),
      completed_at: null,
      local_date: localDate,
      photo_key: null,
      topic_ids: [],
      hole_id: reviewHole?.id ?? null,
      duration_seconds: null,
      context: null,
      // 会話はまだ始まっていない。ここが null のあいだ、この行は時間集計に入れない。
      started_at: null,
      max_seconds: null,
      quota_settled_at: null,
    },
    maxAnalysesPerDay: analysesPerDay({ user, now: at, limits }),
  });
  if (!created) {
    // 授業ではなく解析の上限。**ここに来るのは異常利用だけ**なので、
    // 文言は日次上限と同じ(どちらも数字を出さず「今日はここまで」)にして、
    // 通常の生徒には見えない上限のためにアプリへ新しい分岐を作らない。
    const limitReached = limitReachedAllowance({ user, now: at, limits });
    log?.warn("analysis_limit_reached", { kind: meta.kind, local_date: localDate });
    throw apiError(limitReached.reason, {
      locale,
      retryAfterSeconds: limitReached.retryAfterSeconds,
    });
  }
  /**
   * 会話の言語。**アプリの表示言語ではなく、扱う単元の課程で決まる。**
   *
   * 復習は穴が起点なので、穴が属する課程がそのまま会話の言語になる。
   * 端末を英語に変えただけで、日本語で残した穴に英語で聞きに来ても、
   * 穴の説明文も単元名も日本語のままなので会話が噛み合わない。
   */
  const conversationLocale = reviewHole ? (localeOfTopicId(reviewHole.topic_id) ?? locale) : locale;

  let topicIds: string[] = reviewHole ? [reviewHole.topic_id] : [];
  let photoKey: string | null = null;
  let summary = reviewHole ? reviewSummary(conversationLocale, reviewHole.desc) : "";
  let visibleWork: string[] = [];
  let questionSeeds: string[] = reviewHole ? [reviewHole.desc] : [];
  let analysis: PhotoAnalysis | null = null;
  let problem: SessionProblem | null = null;
  /** 写真を読んでいないセッション(復習)では `null` のまま。 */
  let problemOutcome: ProblemOutcome | null = null;

  let allowed: AllowedTopics;
  try {
    if (photo instanceof File || problemPhoto instanceof File) {
      /**
       * 2枚は**それぞれ独立に**読む。片方が読めなくても、もう片方が読めれば進む。
       * 形式はクライアントの申告ではなく中身で決める(決められないものを
       * Vision APIに投げても400が返るだけ)。
       *
       * 片方が読めないだけで422にすると、**任意のはずの写真が事実上の必須**になる。
       * 読めなかった枚数ではなく、**読めた枚数がゼロかどうか**だけを下で見る。
       */
      let notesImage: PhotoAnalysisImage | undefined;
      if (photo instanceof File) {
        const image = await photo.arrayBuffer();
        const mediaType = detectImageMediaType(image, photo.type);
        if (mediaType) {
          notesImage = { image, contentType: mediaType };
          // ノートは生徒本人の著作物なので保存する。
          photoKey = `photos/${deviceId}/${sessionId}`;
          await c.env.PHOTOS.put(photoKey, image, {
            httpMetadata: { contentType: mediaType },
          });
        } else {
          log?.warn("notes_photo_unreadable", { session_id: sessionId });
        }
      }

      /**
       * 問題の写真。**ここには `PHOTOS.put` が無い。それが仕様。**
       *
       * 教科書・問題集の紙面は他者の著作物なので、解析には送るが保存しない
       * (計画書 §4-1 / §10-4 を「解析後破棄」で決着させたもの)。
       * 解析が終われば `problemImage` は参照されなくなり、そのまま捨てられる。
       */
      let problemImage: PhotoAnalysisImage | undefined;
      if (problemPhoto instanceof File) {
        const bytes = await problemPhoto.arrayBuffer();
        const problemMediaType = detectImageMediaType(bytes, problemPhoto.type);
        if (problemMediaType) {
          problemImage = { image: bytes, contentType: problemMediaType };
        } else {
          log?.warn("problem_photo_unreadable", { session_id: sessionId });
        }
      }

      // 読めた写真が1枚も残らなければ、ここで「読み取れなかった」として返す。
      // 画像なしで解析器を呼ぶと、写真を見ないまま想像で単元を答えることがある。
      const images = notesImage
        ? { notes: notesImage, problem: problemImage }
        : problemImage
          ? { problem: problemImage }
          : null;
      if (!images) throw apiError("photo_unreadable", { locale });

      analysis = await analyzer.analyze({
        ...images,
        locale: conversationLocale,
        stage: meta.school_stage,
      });
      // 対応していない教科・ノートでない写真は、ここで止める。
      // 「数学ではない」ではなく「範囲外」で見るのが要点 — 教科が増えても
      // この行は変わらない。
      if (analysis.subject === "other") {
        throw apiError("out_of_scope", { locale });
      }

      const resolved = resolveDetectedTopics(analysis, conversationLocale, meta.school_stage);
      topicIds = resolved.topicIds;
      summary = analysis.summary;
      visibleWork = analysis.visible_work;
      questionSeeds = analysis.question_seeds;

      const resolvedProblem = resolveSessionProblem({
        analysis,
        hadProblemPhoto: problemImage !== undefined,
      });
      problem = resolvedProblem.problem;
      problemOutcome = resolvedProblem.outcome;

      // §0 決定4「問題とノートをセットで送る」が実際に効いているかは、ここでしか観測できない。
      // not_found が大半なら §4-1 のヒントが弱く、too_long が出るなら解析プロンプトが効いていない。
      log?.info("problem_resolved", {
        session_id: sessionId,
        outcome: resolvedProblem.outcome,
        source: problem?.source ?? null,
        // 紙面は保存しない。**残す痕跡も「送られてきた事実」だけ**にする。
        problem_photo: problemPhoto instanceof File ? "analyzed_and_discarded" : "absent",
        // ノート無しがどれくらい正規の経路になるかは、ここでしか観測できない。
        // 大半がこちらに寄るなら、それは「手も付けられない」が中心的な用件だったということ。
        notes_photo: notesImage ? "stored" : "absent",
      });
    }

    // ユーザーがチップUIで単元を直していれば、そちらを優先する
    if (meta.topic_ids && meta.topic_ids.length > 0) {
      topicIds = meta.topic_ids;
    }

    allowed = buildAllowedTopics(topicIds);
    if (allowed.primary.size === 0) {
      throw apiError("photo_unreadable", { locale });
    }
  } catch (error) {
    // 押さえた枠を返す。読み取れなかった写真で今日の授業枠を失わせない。
    await repository.deleteSession(sessionId);

    // 「写真が読めない」は想定内(ユーザーに文言が返る)。
    // Vision APIが落ちている・鍵が切れているのは想定外で、直さないと誰も始められない。
    if (error instanceof HTTPException) {
      log?.warn("session_rejected", { session_id: sessionId, status: error.status });
    } else {
      log?.error("photo_analysis_failed", error, { session_id: sessionId, kind: meta.kind });
    }
    throw error;
  }

  // 単元を絞り込むとき(PATCH /topics)に写真をもう一度解析しないで済むよう、
  // 解析の結果をセッションに残す。
  const context: SessionContext = {
    summary,
    // 写真は残らないので、問題文の保存先はここだけ(理由は SessionContext のコメント)。
    problem,
    // 読めなかった理由も一緒に残す。確認画面が出す言葉が落ち方で変わるので、
    // ここを落とすと PATCH /topics のあとに理由だけが消える。
    problem_outcome: problemOutcome,
    visible_work: visibleWork,
    question_seeds: questionSeeds,
    topics: analysis?.topics ?? [],
  };

  await repository.updateSessionTopics({
    sessionId,
    topicIds: [...allowed.primary],
    photoKey,
    context,
  });

  // 解析まで来たセッションのうち、何本が実際に会話まで進むか(= `session_started`)は
  // この2行の差でしか見えない。撮ってやめた人の多さは、確認画面の作りへ返す値。
  log?.info("session_created", {
    session_id: sessionId,
    kind: meta.kind,
    locale: conversationLocale,
    topic_ids: [...allowed.primary],
  });

  const response: CreateSessionResponse = {
    session_id: sessionId,
    kind: meta.kind,
    detected_topics: buildDetectedTopics(allowed, context),
    problem,
    problem_outcome: problemOutcome,
  };

  return c.json(response, 201);
});

/**
 * POST /v1/sessions/{id}/start
 *
 * **会話を始める。ここが日次の持ち時間を仮押さえする唯一の場所。**
 *
 * 枠の確保とトークンの発行を1つの操作にまとめてあるのが要点で、順番は入れ替えられない
 * (枠を取れなければトークンは出ないし、トークンが出たなら枠は取れている)。
 * 解析の時点でトークンを配っていた頃は、**鍵を持っている = いつでも始められる**ので、
 * 「会話の開始で数える」と言っても数える口をクライアント側に置いたのと同じだった。
 *
 * 写真はもう解析しない。単元も問題文もセッションに残っているので、ここでやるのは
 * 枠を押さえて、その文脈をトークンに載せ直すことだけ。
 */
sessionsRoute.post("/:sessionId/start", async (c) => {
  const { repository, now } = c.get("services");
  const log = c.get("log");
  const deviceId = c.get("deviceId");
  const at = now();
  const limits = readLimits(c.env);

  // ボディはエラー文言の言語だけ。**無くても始められる**(会話の言語は単元が決める)。
  const parsed = startSessionRequestSchema.safeParse(await c.req.json().catch(() => null));
  const locale = parsed.success ? parsed.data.locale : "ja";

  const sessionId = c.req.param("sessionId");
  // 離脱・クラッシュで /complete が来なかった回は、最初のトークンの寿命後に
  // 仮押さえ額で精算する。残高のSUMは精算前もmax_secondsを数えるので、この更新と
  // 同時に別の開始が来ても二重取りにはならない。
  await repository.settleExpiredSessions({
    deviceId,
    now: at.toISOString(),
    graceSeconds: tokenGraceSeconds,
  });
  const session = await repository.getSession(sessionId);
  // 他人のセッションと、終わったセッションには触らせない。
  if (!session || session.device_id !== deviceId || session.status !== "open") {
    throw apiError("session_not_found", { locale });
  }

  // 解析で単元が決まっていないセッションは、ガードレールの基準が空になる。
  const allowed = buildAllowedTopics(session.topic_ids);
  if (allowed.primary.size === 0) throw apiError("photo_unreadable", { locale });

  const user = await repository.ensureUser(deviceId, at);
  // 契約は作成時にも見ているが、そこから期限が切れていることがある。
  // 従量原価が動くのはこの入口なので、ここでもう一度見る。
  if (session.kind === "review" && !hasPremiumAccess({ user, now: at, limits })) {
    throw apiError("premium_required", { locale });
  }

  /**
   * 押し直しでトークンを出し直せるのは、**最初の鍵が生きているあいだだけ**
   * (理由は {@link canReissueToken})。
   *
   * ここが無いと、部屋に入らないまま開いたセッションが**期限のない鍵の引換券**になる。
   * 会話が成立しなければ `/complete` は来ないので行は open のまま残り、
   * 翌日そのIDで押せば、今日の残高を減らさずに授業時間が増えてしまう。
   */
  if (
    session.started_at !== null &&
    !canReissueToken({
      startedAt: session.started_at,
      now: at,
      maxSeconds: session.max_seconds ?? sessionMaxSeconds({ user, now: at, limits }),
    })
  ) {
    // 「もう入る部屋が無い」は、アプリからは消えたセッションと同じ。
    // 押し直しの経路が同じIDで回り続けないよう、404で終わらせる。
    log?.info("session_start_expired", {
      session_id: session.id,
      started_at: session.started_at,
    });
    throw apiError("session_not_found", { locale });
  }

  /**
   * 復習で教え直す穴。**トークンを出すたびに正本から読み直す。**
   *
   * `context.summary` から復元する案は採らない。そこは表示用に整形済みで、
   * 何より本人の発話 `evidence` が戻らない(PATCH /topics と同じ理由)。
   */
  const reviewHole =
    session.kind === "review" && session.hole_id !== null
      ? await repository.getHole(session.hole_id)
      : null;
  if (session.kind === "review" && (!reviewHole || reviewHole.device_id !== deviceId)) {
    throw apiError("session_not_found", { locale });
  }

  const started = await repository.startSession({
    sessionId: session.id,
    deviceId,
    startedAt: at.toISOString(),
    // 数える日は、撮った日ではなく**始めた日**。日付をまたいで始めた会話は今日の時間。
    localDate: toLocalDate(at),
    secondsPerDay: secondsPerDay({ user, now: at, limits }),
    sessionMaxSeconds: sessionMaxSeconds({ user, now: at, limits }),
    minimumSessionSeconds,
    maxStartsPerDay: maxSessionStartsPerDay,
  });
  if (!started.started) {
    const limitReached = limitReachedAllowance({ user, now: at, limits });
    throw apiError(limitReached.reason, {
      locale,
      retryAfterSeconds: limitReached.retryAfterSeconds,
    });
  }
  const allowance = startedAllowance({
    maxSeconds: started.maxSeconds,
    remainingSecondsToday: started.remainingSecondsToday,
    sessionsToday: started.sessionsToday,
  });

  const context: SessionContext = session.context ?? {
    summary: "",
    problem: null,
    visible_work: [],
    question_seeds: [],
    topics: [],
  };

  // エージェントに渡す文脈。会話中のガードレールはこれを基準にする。
  const metadata = buildSessionMetadata({
    sessionId: session.id,
    // 会話の言語は単元の課程に従う(端末の表示言語ではない)。
    locale: allowedTopicsLocale(allowed),
    kind: session.kind,
    maxSeconds: allowance.maxSeconds,
    context,
    allowed,
    isPremium: user.is_premium,
    // 写真は解析し直さないので、保存済みのキーの有無がそのまま「ノートがあったか」。
    hasNotesPhoto: session.photo_key !== null,
    reviewHole,
  });

  const dispatch = agentDispatch(c.env, metadata);
  const token = await createLiveKitToken({
    apiKey: c.env.LIVEKIT_API_KEY,
    apiSecret: c.env.LIVEKIT_API_SECRET,
    identity: deviceId,
    room: session.id,
    // 押し直しを受け付ける窓と同じ長さ。片方だけ伸ばすと、
    // 「鍵は生きているのに出し直せない」か、その逆ができる。
    ttlSeconds: allowance.maxSeconds + tokenGraceSeconds,
    metadata,
    agent: dispatch,
    now: at,
  });

  // 会話が始まらないという報告は、ここから追う。
  // ルームは作れているのか、後輩をどう呼んでいるのか(明示か自動か)が要る。
  log?.info("session_started", {
    session_id: session.id,
    kind: session.kind,
    locale: allowedTopicsLocale(allowed),
    topic_ids: [...allowed.primary],
    max_seconds: allowance.maxSeconds,
    agent_dispatch: dispatch ? "explicit" : "automatic",
    // 押し直し・つなぎ直しでトークンだけ出し直した回。枠は数え直していない。
    replayed: started.alreadyStarted,
  });

  const response: StartSessionResponse = {
    session_id: session.id,
    kind: session.kind,
    livekit: { url: c.env.LIVEKIT_URL, token, room: session.id },
    limits: {
      max_seconds: allowance.maxSeconds,
      remaining_seconds_today: allowance.remainingSecondsToday,
      lesson_allowed_today: allowance.lessonAllowedToday,
    },
  };

  return c.json(response, 200);
});

/**
 * PATCH /v1/sessions/{id}/topics
 *
 * チップUIで外した単元を反映する。**セッションは作り直さない**。
 *
 * 以前はここで POST /v1/sessions をもう一度呼んでいたため、写真を撮って
 * 単元を確認しただけで当時の無料枠(1日1回)を2回消費し、会話を始める瞬間に
 * 「今日のセッションはここまで」と言われていた。同じ写真を2度Vision LLMへ通す
 * ことにもなるので、単元が変わってもセッションは同じ行のまま書き換える。
 *
 * **ここでもトークンは出さない。** 部屋の鍵が出るのは `/start` だけで、
 * その時点のセッション(= 絞り込んだあとの単元)から文脈を組み立てる。
 */
sessionsRoute.patch("/:sessionId/topics", async (c) => {
  const { repository } = c.get("services");
  const deviceId = c.get("deviceId");

  const parsed = updateSessionTopicsRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw apiError("photo_unreadable");
  const { locale, topic_ids: requested } = parsed.data;

  const sessionId = c.req.param("sessionId");
  const session = await repository.getSession(sessionId);
  // 他人のセッションと、終わったセッションには触らせない。
  if (!session || session.device_id !== deviceId || session.status !== "open") {
    throw apiError("session_not_found", { locale });
  }

  // 選べるのは解析で検出した単元の中だけ。ここを開けると、写真と関係のない
  // 単元に差し替えてガードレールを迂回できてしまう。
  const detected = new Set(session.topic_ids);
  const allowed = buildAllowedTopics(requested.filter((topicId) => detected.has(topicId)));
  if (allowed.primary.size === 0) throw apiError("photo_unreadable", { locale });

  const context: SessionContext = session.context ?? {
    summary: "",
    problem: null,
    visible_work: [],
    question_seeds: [],
    topics: [],
  };

  await repository.updateSessionTopics({
    sessionId,
    topicIds: [...allowed.primary],
    photoKey: session.photo_key,
    context,
  });

  const response: UpdateSessionTopicsResponse = {
    session_id: sessionId,
    kind: session.kind,
    detected_topics: buildDetectedTopics(allowed, context),
    // 写真は解析し直さない。問題文もセッションに残したものをそのまま返す。
    problem: context.problem ?? null,
    problem_outcome: context.problem_outcome ?? null,
  };

  return c.json(response, 200);
});

/**
 * PATCH /v1/sessions/{id}/problem
 *
 * **問題文を、生徒が自分で打ち直す。** 読めなかったときの救済と、誤読の訂正。
 *
 * ## なぜこの口が要るか
 *
 * 問題の紙面は解析後に破棄する(著作物。`contract` の `sessionPhotoParts`)ので、
 * **問題文の保存先は解析結果ひとつだけ**。読めなければ授業は
 * 「問題、読んでもらってもいい?」から始まり、**画面に見えている問題を、
 * 生徒がもう一度声で入力させられる**。外部テスターが挙げた唯一の不満がこれで、
 * 確認画面には読み合わせの枠があるのに、そこから直す手が無かった。
 *
 * ## 写真は触らない
 *
 * 受け取るのはテキストだけで、**Vision LLMを回さない**。だから
 * `analysesPerDay` の枠も原価も動かない — 救済の口が上限に当たって塞がる、
 * という裏返りが起きない。同じ紙面を投げ直しても、解答が混ざる原因は
 * 「紙面のどこを写したか」なので同じものが返る(`problem-guard.ts` と同じ判断)。
 *
 * ## 打ち直した本文も素通しにしない
 *
 * `checkProblemText()` を通す。写真から来た問題文に対して塞いだ穴
 * (解答が混ざると、先輩は解き方を組み立てずに答えを写す)は、
 * **手入力の側からも同じように開く**。
 *
 * ただし落としたときは、写真のときと違って**黙って `null` に畳まない。**
 * 打った本人が目の前にいるので、`problem_unreadable` を返して直せるようにする。
 * 黙って畳むと「打ったのに何も変わらない」になり、この口を作った意味が消える。
 *
 * **ここでもトークンは出さない。** 会話の文脈は `/start` がセッションから
 * 組み立て直すので、始める前に書き換えておけば、そのまま先輩に届く。
 */
sessionsRoute.patch("/:sessionId/problem", async (c) => {
  const { repository } = c.get("services");
  const log = c.get("log");
  const deviceId = c.get("deviceId");

  const parsed = updateSessionProblemRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw apiError("problem_unreadable");
  const { locale } = parsed.data;

  /**
   * 端末側は入力欄の時点で `problemTextMaxLength` に丸めている。
   * ここで見るのは、その画面を通っていない呼び出し。**先頭で切らない** —
   * 写真から読んだときと同じで、途中で切れた問題を教えることになる。
   */
  const text = parsed.data.text.trim();
  if (text.length === 0 || text.length > problemTextMaxLength) {
    throw apiError("problem_unreadable", { locale });
  }

  const sessionId = c.req.param("sessionId");
  const session = await repository.getSession(sessionId);
  // 他人のセッションと、終わったセッションには触らせない(PATCH /topics と同じ門)。
  if (!session || session.device_id !== deviceId || session.status !== "open") {
    throw apiError("session_not_found", { locale });
  }

  // 単元が空のセッションは、そもそも会話を始められない(応答の形も満たせない)。
  const allowed = buildAllowedTopics(session.topic_ids);
  if (allowed.primary.size === 0) throw apiError("photo_unreadable", { locale });

  /**
   * **写真のときより厳しく見る。** 裸の `Answer:` を通しているのは
   * 「紙面には解く前から空欄の解答欄が印刷されている」からで、その理由は
   * 自分で打ち込んだ本文には立たない(`problem-guard.ts` の `typedAnswerHeading`)。
   */
  const verdict = checkProblemText(text, "manual");
  if (!verdict.ok) {
    // 何が弾かれているかは、ここでしか見えない。頻度が高ければ、直すのは
    // 文言か入力欄の側(`problem-guard.ts` の「迷ったら通す」は動かさない)。
    log?.info("problem_manual_rejected", { session_id: sessionId, reason: verdict.reason });
    throw apiError("problem_unreadable", { locale });
  }

  const previous: SessionContext = session.context ?? {
    summary: "",
    problem: null,
    visible_work: [],
    question_seeds: [],
    topics: [],
  };
  const context: SessionContext = {
    ...previous,
    // 出どころは写真ではなく本人。**写真の2枠と同じ軸に並べる**(`problemSources`)。
    problem: { text, source: "manual" },
    problem_outcome: "read",
  };

  await repository.updateSessionTopics({
    sessionId,
    // 単元はここでは動かさない。動かす口は PATCH /topics。
    topicIds: session.topic_ids,
    photoKey: session.photo_key,
    context,
  });

  // 手入力がどれくらい使われるか(= 解析の `not_found` 率とセットで読む値)。
  // ここが伸びるなら、直すべきは撮影の案内か解析プロンプトの側。
  log?.info("problem_edited", {
    session_id: sessionId,
    // 救済(読めなかった)か、訂正(読めていたが違った)か。効く手当てが別物になる。
    replaced: previous.problem ? "correction" : "rescue",
    from_outcome: previous.problem_outcome ?? null,
  });

  const response: UpdateSessionProblemResponse = {
    session_id: sessionId,
    kind: session.kind,
    detected_topics: buildDetectedTopics(allowed, context),
    problem: context.problem ?? null,
    problem_outcome: context.problem_outcome ?? null,
  };

  return c.json(response, 200);
});

/**
 * 後輩(agent)をこの部屋に呼ぶ指定。
 *
 * ワーカーが名前つきで動いているとき(LiveKit Cloud のエージェントホスティングは
 * `LIVEKIT_AGENT_NAME` を自動で入れる)、自動ディスパッチは効かない。
 * **トークンに載せて、部屋が作られる瞬間に呼ぶ。** ここが空だと、アプリは
 * ルームに入れるのに誰も来ず、「聞いています」のまま上限時間まで止まる。
 *
 * 名前なしで動かしている(自動ディスパッチ)なら未設定でよい。
 */
function agentDispatch(env: Bindings, metadata: string): AgentDispatch | undefined {
  const name = env.LIVEKIT_AGENT_NAME?.trim();
  if (!name) return undefined;
  // 参加者metadataと同じ内容をジョブにも渡す。ディスパッチが先に走っても、
  // エージェントは参加者を待たずに文脈を読める。
  return { name, metadata };
}

/**
 * 復習セッションの「今日のノート」。写真がないので、前回の穴を文脈にする。
 * プロンプトに貼る文字列なので、会話の言語で書く。
 */
function reviewSummary(locale: "ja" | "en", desc: string): string {
  return locale === "en" ? `Last time, ${desc}` : `前回、${desc}`;
}

/**
 * ノートに書いてあることとしてプロンプトへ渡す値。
 *
 * **文言そのものは持たない。**`@ai-sensei/prompts` の {@link formatVisibleWork} が
 * 唯一の置き場で(`prompts/senpai_*.md` がその文字列を名指ししている)、
 * ここが決めるのは **`null` を渡すかどうか**だけ。
 * `problem_text` のときに「埋める場所が2つあると経路で文言が変わる」と書いたのと
 * 同じ理由で、API側で組み立て直さない。
 *
 * `null`(= ノートの写真なし)にするのは `kind: "new"` のときだけ。
 * 復習セッションはそもそも写真を使わず、文脈は前回の穴なので、
 * ここで「ノートの写真なし」と言うと**存在しない欠落**を報告することになる。
 *
 * **送られたが読めなかったノートも `null` 側に入る。** 先輩から見れば
 * 「撮っていない」も「読めなかった」も手がかりがゼロという点で同じで、
 * 「(なし)」= 撮ったが白紙、と言い切るほうが実態から遠い。
 */
function studentWorkForPrompt(input: {
  locale: "ja" | "en";
  kind: "new" | "review";
  visibleWork: readonly string[];
  hasNotesPhoto: boolean;
}): string {
  const noNotesPhoto = input.kind === "new" && !input.hasNotesPhoto;
  return formatVisibleWork(noNotesPhoto ? null : input.visibleWork, input.locale);
}

/**
 * エージェントがトークンから読む会話文脈。形は `contract` の {@link SessionMetadata}。
 *
 * **`SessionMetadata` で型検査し、共有スキーマで実行時検証してから文字列化する。**
 * ここが素の object リテラルだったために `problem_text` の欄が無いことに誰も気づかず、
 * agent は `photo_summary`(「何が写っているか」の要約)を問題文として流用していた
 * = 先輩が問題そのものを見ないまま教えていた(計画書 §0 決定4 の未実装)。
 * 型は実行時には消えるので、検証なしでは壊れた封筒をトークンへ載せてしまう。
 */
function buildSessionMetadata(input: {
  sessionId: string;
  locale: "ja" | "en";
  kind: "new" | "review";
  maxSeconds: number;
  context: SessionContext;
  allowed: AllowedTopics;
  isPremium: boolean;
  /** ノートの写真がR2にあるか(= 送られてきたか)。`student_work` の文言が変わる。 */
  hasNotesPhoto: boolean;
  /** 復習で教え直す1つの穴。新規授業では `null`。 */
  reviewHole: HoleRecord | null;
}): string {
  const metadata = sessionMetadataSchema.parse({
    session_id: input.sessionId,
    locale: input.locale,
    kind: input.kind,
    max_seconds: input.maxSeconds,
    photo_summary: input.context.summary,
    // 整形済みの断片はそのままプロンプトに貼られる。空のときの
    // プレースホルダまで含めて、会話の言語で揃える。
    // 文言そのものは持たない。`formatVisibleWork` と同じで、
    // **プロンプトが名指ししている文字列は `@ai-sensei/prompts` に集めてある**。
    // ここが決めるのは「読めたか(= `null` を渡すか)」だけ。
    problem_text: formatProblemText(input.context.problem?.text ?? null, input.locale),
    visible_work: studentWorkForPrompt({
      locale: input.locale,
      kind: input.kind,
      visibleWork: input.context.visible_work,
      hasNotesPhoto: input.hasNotesPhoto,
    }),
    question_seeds: formatBullets(input.context.question_seeds, input.locale),
    allowed_topics: formatAllowedTopics(allowedTopicList(input.allowed), input.locale),
    allowed_topic_ids: [...input.allowed.primary, ...input.allowed.prerequisite],
    is_premium: input.isPremium,
    // 前回のカルテ全体は載せない。対象外の穴や「言えたこと」まで板書LLMへ渡すと、
    // 1回1穴の復習が前回セッション全体の再講義へ広がる。対象穴の説明と、
    // その根拠になった本人の言葉だけで、教え直す地点は特定できる。
    review_hole:
      input.reviewHole === null
        ? null
        : {
            topic_id: input.reviewHole.topic_id,
            desc: input.reviewHole.desc,
            evidence: input.reviewHole.evidence,
          },
  } satisfies SessionMetadata);
  return JSON.stringify(metadata);
}

/**
 * チップUIに出す単元。
 * 解析器が返した確信度をそのまま渡す。ここで捨てると、確信度の高い候補まで
 * フォールバック値(0.4)になり、チップUIが全部「候補」表示になってしまう。
 */
function buildDetectedTopics(allowed: AllowedTopics, context: SessionContext) {
  return toDetectedTopicPayload([...allowed.primary], {
    subject: "math",
    summary: context.summary,
    problem_text: context.problem?.text ?? "",
    visible_work: context.visible_work,
    topics: context.topics,
    unreadable: [],
    question_seeds: context.question_seeds,
  });
}

// 戻り値は契約の型そのもの。手で並べ直すと、フィールドを足したときに
// 「スキーマは通るのにサーバからは見えない」状態が静かにできる。
function parseMeta(value: File | string | null): CreateSessionRequest {
  if (typeof value !== "string" || value.length === 0) {
    // metaパートが無いのは古いアプリ。スキーマの既定と同じものを返す。
    return createSessionRequestSchema.parse({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw apiError("photo_unreadable");
  }
  const parsed = createSessionRequestSchema.safeParse(raw);
  if (!parsed.success) throw apiError("photo_unreadable");
  return parsed.data;
}
