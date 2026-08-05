import { type CreateSessionResponse, createSessionRequestSchema } from "@ai-sensei/contract";
import {
  type AllowedTopics,
  allowedTopicList,
  buildAllowedTopics,
  toLocalDate,
} from "@ai-sensei/guardrail";
import { formatAllowedTopics, formatBullets } from "@ai-sensei/prompts";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { readLimits } from "../env.ts";
import { checkSessionAllowance, isPremiumNow } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import { createLiveKitToken } from "../lib/livekit.ts";
import {
  type PhotoAnalysis,
  detectImageMediaType,
  resolveDetectedTopics,
  toDetectedTopicPayload,
} from "../lib/photo-analysis.ts";
import type { HoleRecord } from "../repository/types.ts";

export const sessionsRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions
 *
 * 写真を受け取り、Vision LLMで単元を判定し、LiveKitルームとトークンを返す。
 * ここで作った許可トピックが、会話中のガードレールの基準になる。
 */
sessionsRoute.post("/", async (c) => {
  const { repository, analyzer, now, newId } = c.get("services");
  const deviceId = c.get("deviceId");
  const at = now();
  const limits = readLimits(c.env);

  const form = await c.req.formData();
  const meta = parseMeta(form.get("meta"));
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
  });
  let topicIds: string[] = reviewHole ? [reviewHole.topic_id] : [];
  let photoKey: string | null = null;
  let summary = reviewHole ? `前回、${reviewHole.desc}` : "";
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

      analysis = await analyzer.analyze({ image, contentType: mediaType });
      if (!analysis.is_math_note) {
        throw apiError("out_of_scope", { locale });
      }

      const resolved = resolveDetectedTopics(analysis);
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
    throw error;
  }

  await repository.updateSessionTopics({
    sessionId,
    topicIds: [...allowed.primary],
    photoKey,
  });

  // エージェントに渡す文脈。会話中のガードレールはこれを基準にする。
  const metadata = JSON.stringify({
    session_id: sessionId,
    locale,
    kind: meta.kind,
    max_seconds: allowance.maxSeconds,
    photo_summary: summary,
    visible_work: formatBullets(visibleWork),
    question_seeds: formatBullets(questionSeeds),
    allowed_topics: formatAllowedTopics(allowedTopicList(allowed)),
    allowed_topic_ids: [...allowed.primary, ...allowed.prerequisite],
    is_premium: user.is_premium,
  });

  const token = await createLiveKitToken({
    apiKey: c.env.LIVEKIT_API_KEY,
    apiSecret: c.env.LIVEKIT_API_SECRET,
    identity: deviceId,
    room: sessionId,
    ttlSeconds: allowance.maxSeconds + 120,
    metadata,
    now: at,
  });

  const response: CreateSessionResponse = {
    session_id: sessionId,
    kind: meta.kind,
    livekit: { url: c.env.LIVEKIT_URL, token, room: sessionId },
    // 解析器が返した確信度をそのまま渡す。ここで捨てると、確信度の高い候補まで
    // フォールバック値(0.4)になり、チップUIが全部「候補」表示になってしまう。
    detected_topics: toDetectedTopicPayload([...allowed.primary], {
      is_math_note: true,
      summary,
      visible_work: visibleWork,
      topics: analysis?.topics ?? [],
      unreadable: analysis?.unreadable ?? [],
      question_seeds: questionSeeds,
    }),
    limits: {
      max_seconds: allowance.maxSeconds,
      remaining_sessions_today: allowance.remainingToday,
    },
  };

  return c.json(response, 201);
});

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
