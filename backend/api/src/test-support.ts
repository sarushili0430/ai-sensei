import { sessionPhotoParts } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import type { D1Database, KVNamespace, R2Bucket } from "./cloudflare.ts";
import type { Bindings, Services } from "./env.ts";
import type { NotificationScheduler } from "./lib/notifications.ts";
import type { PhotoAnalysis, PhotoAnalyzer, PhotoAnalyzerInput } from "./lib/photo-analysis.ts";
import { MemoryRepository } from "./repository/memory.ts";

/**
 * Test scaffolding.
 * Lets route behaviour be checked without touching the network or D1.
 */

export const analysisFixture: PhotoAnalysis = {
  subject: "math",
  summary: "円と直線の位置関係の問題。(1)は交点の個数を求めている。",
  problem_text:
    "円 x^2 + y^2 = 5 と直線 y = x + k について、(1) 共有点の個数を求めよ。(2) 接するときの k の値を求めよ。",
  visible_work: ["中心と直線の距離を求めている", "(2)では連立して判別式を使っている"],
  topics: [
    { topic_id: "M2-ZUKEI-ENCHOKU", confidence: 0.92 },
    { topic_id: "M1-NIJI-HANBETSU", confidence: 0.41 },
  ],
  unreadable: [],
  question_seeds: ["方法を変えた理由", "判別式で何がわかるのか"],
};

/** An analysis result for an overseas curriculum (Algebra 1 / Algebra 2 ...). */
export const analysisFixtureEn: PhotoAnalysis = {
  subject: "math",
  summary: "A line-and-circle problem. Part (1) asks for the number of intersection points.",
  problem_text:
    "For the circle x^2 + y^2 = 5 and the line y = x + k: (1) find the number of intersection points. (2) find the value of k that makes them tangent.",
  visible_work: [
    "Finding the distance from the center to the line",
    "In (2), substituting and using the discriminant",
  ],
  topics: [
    { topic_id: "A2-COORD-CIRCLE", confidence: 0.92 },
    { topic_id: "A1-QUAD-SOLVE", confidence: 0.41 },
  ],
  unreadable: [],
  question_seeds: ["Why the method changed", "What the discriminant tells you"],
};

/**
 * A stub analyser that records the locale it was called with.
 * If this passed everything through, an English session handed the Japanese
 * curriculum would be invisible to tests.
 */
export class RecordingAnalyzer implements PhotoAnalyzer {
  /** The locale it was called with, and which photos were passed. */
  readonly calls: { locale: CurriculumLocale; hadNotes: boolean; hadProblem: boolean }[] = [];

  private readonly byLocale: Partial<Record<CurriculumLocale, PhotoAnalysis>>;
  private readonly fallback: PhotoAnalysis;

  constructor(
    fallback: PhotoAnalysis = analysisFixture,
    byLocale: Partial<Record<CurriculumLocale, PhotoAnalysis>> = { en: analysisFixtureEn },
  ) {
    this.fallback = fallback;
    this.byLocale = byLocale;
  }

  async analyze(input: PhotoAnalyzerInput): Promise<PhotoAnalysis> {
    const locale = input.locale ?? "ja";
    this.calls.push({
      locale,
      hadNotes: input.notes !== undefined,
      hadProblem: input.problem !== undefined,
    });
    return this.byLocale[locale] ?? this.fallback;
  }
}

export function stubAnalyzer(analysis: PhotoAnalysis = analysisFixture): PhotoAnalyzer {
  return new RecordingAnalyzer(analysis);
}

export class RecordingScheduler implements NotificationScheduler {
  readonly scheduled: {
    deviceId: string;
    holeId: string;
    step: number;
    sendAt: string;
    desc: string;
    locale?: CurriculumLocale;
  }[] = [];
  readonly cancelled: string[] = [];

  async schedule(input: {
    deviceId: string;
    holeId: string;
    step: 1 | 2 | 3;
    sendAt: string;
    desc: string;
    daysSince: number;
    locale?: CurriculumLocale;
  }): Promise<{ externalId: string | null }> {
    this.scheduled.push(input);
    return { externalId: `os_${this.scheduled.length}` };
  }

  async cancel(externalId: string): Promise<void> {
    this.cancelled.push(externalId);
  }
}

class MemoryR2 implements R2Bucket {
  readonly objects = new Map<string, ArrayBuffer>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string) {
    this.objects.set(key, value instanceof ArrayBuffer ? value : new ArrayBuffer(0));
    return {};
  }

  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { arrayBuffer: async () => object } : null;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

class MemoryKV implements KVNamespace {
  readonly entries = new Map<string, string>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.entries.set(key, value);
  }
  async delete(key: string) {
    this.entries.delete(key);
  }
}

const unusedD1: D1Database = {
  prepare() {
    throw new Error("テストではMemoryRepositoryを使ってください");
  },
  batch() {
    throw new Error("テストではMemoryRepositoryを使ってください");
  },
};

export const testDeviceId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
export const internalToken = "test-internal-token";

export function testBindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: unusedD1,
    PHOTOS: new MemoryR2(),
    METER: new MemoryKV(),
    LIVEKIT_URL: "wss://test.livekit.cloud",
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret-value-for-hmac",
    REVENUECAT_WEBHOOK_AUTH: "test-webhook-auth",
    INTERNAL_API_TOKEN: internalToken,
    FREE_SESSIONS_PER_DAY: "1",
    PREMIUM_SESSIONS_PER_DAY: "3",
    FREE_SESSION_MAX_SECONDS: "1200",
    PREMIUM_SESSION_MAX_SECONDS: "1200",
    // Do not flood test output with a line per request. Failure logs stay.
    LOG_LEVEL: "error",
    ...overrides,
  };
}

export type TestServices = Services & {
  repository: MemoryRepository;
  scheduler: RecordingScheduler;
};

export function testServices(options: { now?: Date; analysis?: PhotoAnalysis } = {}): TestServices {
  let counter = 0;
  return {
    repository: new MemoryRepository(),
    analyzer: new RecordingAnalyzer(options.analysis),
    scheduler: new RecordingScheduler(),
    now: () => options.now ?? new Date("2026-08-03T13:24:07.000Z"),
    // Stable ids in tests (ses_1, kar_2, ...)
    newId: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

/**
 * A barrier that holds everyone until N arrive, then releases them together.
 *
 * Plain Promise.all is not enough: the number of microtasks through things like
 * c.req.formData() differs, so the first request runs to completion. That would
 * give [201, 402, 402] even for a broken "count, then insert" implementation and
 * would not reproduce the concurrency hole, so they are aligned explicitly right
 * before the claim.
 */
export function concurrencyBarrier(count: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) open();
    await gate;
  };
}

/** The minimum byte string that passes as JPEG (SOI marker + APP0). */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/**
 * Builds a multipart/form-data session-creation request.
 *
 * `problemPhoto` is §4-1's second image (the textbook or workbook page). It is
 * optional, so it is not attached by default - "two photos are not required"
 * being upheld on the default path is shown by every test passing without it.
 */
export function createSessionForm(
  meta: Record<string, unknown> = {},
  options: { problemPhoto?: File } = {},
): FormData {
  const form = new FormData();
  // The head is the JPEG magic number. The format is decided from the content, so
  // plain dummy bytes here would be rejected as an unreadable photo.
  form.set(sessionPhotoParts.notes, new File([JPEG_BYTES], "note.jpg", { type: "image/jpeg" }));
  if (options.problemPhoto) form.set(sessionPhotoParts.problem, options.problemPhoto);
  form.set("meta", JSON.stringify({ kind: "new", locale: "ja", ...meta }));
  return form;
}

/** The problem photo (second image). Same dummy content as the notes; only the handling differs. */
export function problemPhotoFile(type = "image/jpeg"): File {
  return new File([JPEG_BYTES], "problem.jpg", { type });
}
