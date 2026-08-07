import {
  type CreateSessionResponse,
  type UpdateSessionTopicsResponse,
  createSessionRequestSchema,
  updateSessionTopicsRequestSchema,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import {
  type AllowedTopics,
  allowedTopicList,
  allowedTopicsLocale,
  buildAllowedTopics,
  toLocalDate,
} from "@ai-sensei/guardrail";
import { formatAllowedTopics, formatBullets } from "@ai-sensei/prompts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Bindings } from "../env.ts";
import { readLimits } from "../env.ts";
import { checkSessionAllowance, isPremiumNow } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import { type AgentDispatch, createLiveKitToken } from "../lib/livekit.ts";
import {
  type PhotoAnalysis,
  detectImageMediaType,
  resolveDetectedTopics,
  toDetectedTopicPayload,
} from "../lib/photo-analysis.ts";
import type { HoleRecord, SessionContext } from "../repository/types.ts";

export const sessionsRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions
 *
 * 写真を受け取り、Vision LLMで単元を判定し、LiveKitルームとトークンを返す。
 * ここで作った許可トピックが、会話中のガードレールの基準になる。
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
  const localDate = toLocalDate(at);

  // 復習(穴の再説明)はPremium機能。/v1/me/reviews でキューを隠すだけだと、
  // 初回カルテで配った hole_id を使ってここから直接呼べてしまう。
  if (meta.kind === "review" && !isPremiumNow(user, at)) {
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

  const sessionsToday = await repository.countSessionsOnDate(deviceId, localDate);
  const allowance = checkSessionAllowance({ user, sessionsToday, now: at, limits });

  if (!allowance.allowed) {
    throw apiError("free_limit_reached", {
      locale,
      retryAfterSeconds: allowance.retryAfterSeconds,
    });
  }

  const photo = form.get("photo");
  if (meta.kind === "new" && !(photo instanceof File)) {
    throw apiError("photo_unreadable", { locale });
  }

  const sessionId = newId("ses");

  // 無料枠の判定と行の作成が離れていると、同時に2本投げられたときに
  // 両方が「今日はまだ0回」を見て通ってしまう。写真のアップロードと解析に
  // 数秒かかるぶん窓が広いので、**先に行を作って枠を押さえる**。
  // 解析に失敗したら下で消すので、失敗が枠を食うこともない。
  await repository.createSession({
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
  });
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

  let allowed: AllowedTopics;
  try {
    if (photo instanceof File) {
      const image = await photo.arrayBuffer();

      // 形式はクライアントの申告ではなく中身で決める。決められないものを
      // Vision APIに投げても400が返るだけなので、ここで「読み取れなかった」
      // として返す(500にしない)。
      const mediaType = detectImageMediaType(image, photo.type);
      if (!mediaType) throw apiError("photo_unreadable", { locale });

      photoKey = `photos/${deviceId}/${sessionId}`;
      await c.env.PHOTOS.put(photoKey, image, {
        httpMetadata: { contentType: mediaType },
      });

      analysis = await analyzer.analyze({
        image,
        contentType: mediaType,
        locale: conversationLocale,
      });
      if (!analysis.is_math_note) {
        throw apiError("out_of_scope", { locale });
      }

      const resolved = resolveDetectedTopics(analysis, conversationLocale);
      topicIds = resolved.topicIds;
      summary = analysis.summary;
      visibleWork = analysis.visible_work;
      questionSeeds = analysis.question_seeds;
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
    // 押さえた枠を返す。読み取れなかった写真で今日の1回を失わせない。
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

  // エージェントに渡す文脈。会話中のガードレールはこれを基準にする。
  const metadata = buildSessionMetadata({
    sessionId,
    locale: conversationLocale,
    kind: meta.kind,
    maxSeconds: allowance.maxSeconds,
    context,
    allowed,
    isPremium: user.is_premium,
  });

  const dispatch = agentDispatch(c.env, metadata);
  const token = await createLiveKitToken({
    apiKey: c.env.LIVEKIT_API_KEY,
    apiSecret: c.env.LIVEKIT_API_SECRET,
    identity: deviceId,
    room: sessionId,
    ttlSeconds: allowance.maxSeconds + 120,
    metadata,
    agent: dispatch,
    now: at,
  });

  // 会話が始まらないという報告は、ここから追う。
  // ルームは作れているのか、後輩をどう呼んでいるのか(明示か自動か)が要る。
  log?.info("session_created", {
    session_id: sessionId,
    kind: meta.kind,
    locale: conversationLocale,
    topic_ids: [...allowed.primary],
    max_seconds: allowance.maxSeconds,
    agent_dispatch: dispatch ? "explicit" : "automatic",
  });

  const response: CreateSessionResponse = {
    session_id: sessionId,
    kind: meta.kind,
    livekit: { url: c.env.LIVEKIT_URL, token, room: sessionId },
    detected_topics: buildDetectedTopics(allowed, context),
    limits: {
      max_seconds: allowance.maxSeconds,
      remaining_sessions_today: allowance.remainingToday,
    },
  };

  return c.json(response, 201);
});

/**
 * PATCH /v1/sessions/{id}/topics
 *
 * チップUIで外した単元を反映する。**セッションは作り直さない**。
 *
 * 以前はここで POST /v1/sessions をもう一度呼んでいたため、写真を撮って
 * 単元を確認しただけで無料枠(1日1回)を2回消費し、会話を始める瞬間に
 * 「今日のセッションはここまで」と言われていた。単元が変わっても
 * 押さえた枠は同じセッションのままにして、トークンだけ出し直す。
 */
sessionsRoute.patch("/:sessionId/topics", async (c) => {
  const { repository, now } = c.get("services");
  const deviceId = c.get("deviceId");
  const at = now();
  const limits = readLimits(c.env);

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

  const user = await repository.ensureUser(deviceId, at);
  const premium = isPremiumNow(user, at);
  const maxSeconds = premium ? limits.premiumSessionMaxSeconds : limits.freeSessionMaxSeconds;

  const context: SessionContext = session.context ?? {
    summary: "",
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

  const metadata = buildSessionMetadata({
    sessionId,
    // 会話の言語は残った単元の課程に従う(作成時と同じ規則)。
    locale: allowedTopicsLocale(allowed),
    kind: session.kind,
    maxSeconds,
    context,
    allowed,
    isPremium: user.is_premium,
  });

  const token = await createLiveKitToken({
    apiKey: c.env.LIVEKIT_API_KEY,
    apiSecret: c.env.LIVEKIT_API_SECRET,
    identity: deviceId,
    room: sessionId,
    ttlSeconds: maxSeconds + 120,
    metadata,
    agent: agentDispatch(c.env, metadata),
    now: at,
  });

  // このセッションはもう数えられているので、残数は「押さえたあと」の値になる。
  const sessionsToday = await repository.countSessionsOnDate(deviceId, session.local_date);

  const response: UpdateSessionTopicsResponse = {
    session_id: sessionId,
    kind: session.kind,
    livekit: { url: c.env.LIVEKIT_URL, token, room: sessionId },
    detected_topics: buildDetectedTopics(allowed, context),
    limits: {
      max_seconds: maxSeconds,
      remaining_sessions_today: premium
        ? null
        : Math.max(0, limits.freeSessionsPerDay - sessionsToday),
    },
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

/** エージェントがトークンから読む会話文脈。 */
function buildSessionMetadata(input: {
  sessionId: string;
  locale: "ja" | "en";
  kind: "new" | "review";
  maxSeconds: number;
  context: SessionContext;
  allowed: AllowedTopics;
  isPremium: boolean;
}): string {
  return JSON.stringify({
    session_id: input.sessionId,
    locale: input.locale,
    kind: input.kind,
    max_seconds: input.maxSeconds,
    photo_summary: input.context.summary,
    // 整形済みの断片はそのままプロンプトに貼られる。空のときの
    // プレースホルダまで含めて、会話の言語で揃える。
    visible_work: formatBullets(input.context.visible_work, input.locale),
    question_seeds: formatBullets(input.context.question_seeds, input.locale),
    allowed_topics: formatAllowedTopics(allowedTopicList(input.allowed), input.locale),
    allowed_topic_ids: [...input.allowed.primary, ...input.allowed.prerequisite],
    is_premium: input.isPremium,
  });
}

/**
 * チップUIに出す単元。
 * 解析器が返した確信度をそのまま渡す。ここで捨てると、確信度の高い候補まで
 * フォールバック値(0.4)になり、チップUIが全部「候補」表示になってしまう。
 */
function buildDetectedTopics(allowed: AllowedTopics, context: SessionContext) {
  return toDetectedTopicPayload([...allowed.primary], {
    is_math_note: true,
    summary: context.summary,
    visible_work: context.visible_work,
    topics: context.topics,
    unreadable: [],
    question_seeds: context.question_seeds,
  });
}

function parseMeta(value: File | string | null): {
  kind: "new" | "review";
  locale: "ja" | "en";
  hole_id?: string;
  topic_ids?: string[];
} {
  if (typeof value !== "string" || value.length === 0) {
    return { kind: "new", locale: "ja" };
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
