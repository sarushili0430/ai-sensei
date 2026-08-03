import { type CreateSessionResponse, createSessionRequestSchema } from "@ai-sensei/contract";
import { allowedTopicList, buildAllowedTopics, toLocalDate } from "@ai-sensei/guardrail";
import { formatAllowedTopics, formatBullets } from "@ai-sensei/prompts";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { readLimits } from "../env.ts";
import { checkSessionAllowance } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import { createLiveKitToken } from "../lib/livekit.ts";
import { resolveDetectedTopics, toDetectedTopicPayload } from "../lib/photo-analysis.ts";
import type { SessionRecord } from "../repository/types.ts";

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
  let topicIds: string[] = [];
  let photoKey: string | null = null;
  let summary = "";
  let visibleWork: string[] = [];
  let questionSeeds: string[] = [];

  if (photo instanceof File) {
    const image = await photo.arrayBuffer();
    photoKey = `photos/${deviceId}/${sessionId}`;
    await c.env.PHOTOS.put(photoKey, image, {
      httpMetadata: { contentType: photo.type || "image/jpeg" },
    });

    const analysis = await analyzer.analyze({
      image,
      contentType: photo.type || "image/jpeg",
    });
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

  const allowed = buildAllowedTopics(topicIds);
  if (allowed.primary.size === 0) {
    throw apiError("photo_unreadable", { locale });
  }

  const session: SessionRecord = {
    id: sessionId,
    device_id: deviceId,
    kind: meta.kind,
    status: "open",
    created_at: at.toISOString(),
    completed_at: null,
    local_date: localDate,
    photo_key: photoKey,
    topic_ids: [...allowed.primary],
    hole_id: meta.hole_id ?? null,
    duration_seconds: null,
  };
  await repository.createSession(session);

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
    detected_topics: toDetectedTopicPayload([...allowed.primary], {
      is_math_note: true,
      summary,
      visible_work: visibleWork,
      topics: [],
      unreadable: [],
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
