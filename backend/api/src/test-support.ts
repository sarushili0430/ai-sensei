import { sessionPhotoParts } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import type { D1Database, KVNamespace, R2Bucket } from "./cloudflare.ts";
import type { Bindings, Services } from "./env.ts";
import type { PracticeGrader, PracticeGrading } from "./lib/grading.ts";
import type { NotificationScheduler } from "./lib/notifications.ts";
import type { PhotoAnalysis, PhotoAnalyzer, PhotoAnalyzerInput } from "./lib/photo-analysis.ts";
import { MemoryRepository } from "./repository/memory.ts";

/**
 * テスト用の足場。
 * ネットワークもD1も使わずに、ルートの振る舞いだけを確かめられるようにする。
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

/** 海外向けの課程(Algebra 1 / Algebra 2 ...)で返ってくる解析結果。 */
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
 * 解析器のスタブ。**呼ばれたロケールを記録する**。
 * ここが素通しだと、英語のセッションで日本語のカリキュラムを
 * 渡していても、テストからは気づけない。
 */
export class RecordingAnalyzer implements PhotoAnalyzer {
  /** 呼ばれたロケールと、どちらの写真が渡されたか。 */
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

  readonly scheduledPractice: {
    deviceId: string;
    problemId: string;
    step: number;
    sendAt: string;
    topicLabel: string;
    daysSince: number;
    locale?: CurriculumLocale;
  }[] = [];

  async schedulePractice(input: {
    deviceId: string;
    problemId: string;
    step: 1 | 2 | 3;
    sendAt: string;
    topicLabel: string;
    daysSince: number;
    locale?: CurriculumLocale;
  }): Promise<{ externalId: string | null }> {
    this.scheduledPractice.push(input);
    return { externalId: `os_p${this.scheduledPractice.length}` };
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
    // `wrangler.toml` と同じ値で回す。既定値をテストだけ広げると、
    // 無料の「1日1回・10分」が本番でしか効かない状態に気づけない。
    FREE_SECONDS_PER_DAY: "600",
    PREMIUM_SECONDS_PER_DAY: "3600",
    FREE_SESSION_MAX_SECONDS: "600",
    PREMIUM_SESSION_MAX_SECONDS: "1200",
    // テスト出力を1リクエスト1行で埋めない。失敗のログは残す。
    LOG_LEVEL: "error",
    ...overrides,
  };
}

/**
 * 採点を固定するテスト用の採点器。
 *
 * **既定は `correct`。**「不正解なら1日後にも通知する」が新しい分岐なので、
 * 既定を `incorrect` にすると、段の検査が既定値のせいで通ってしまう。
 * 段を見るテストは必ず `verdict` を明示すること。
 */
export class StubGrader implements PracticeGrader {
  readonly graded: { question: string; answer: string; response: string }[] = [];

  constructor(
    private result: PracticeGrading = { verdict: "correct", comment: "いいね", gradedBy: "stub" },
  ) {}

  set(result: PracticeGrading): void {
    this.result = result;
  }

  async grade(input: {
    question: string;
    answer: string;
    response: string;
  }): Promise<PracticeGrading> {
    this.graded.push(input);
    return this.result;
  }
}

export type TestServices = Services & {
  repository: MemoryRepository;
  scheduler: RecordingScheduler;
  grader: StubGrader;
};

export function testServices(options: { now?: Date; analysis?: PhotoAnalysis } = {}): TestServices {
  let counter = 0;
  return {
    repository: new MemoryRepository(),
    analyzer: new RecordingAnalyzer(options.analysis),
    grader: new StubGrader(),
    scheduler: new RecordingScheduler(),
    now: () => options.now ?? new Date("2026-08-03T13:24:07.000Z"),
    // テストで安定したIDにする(ses_1, kar_2, ...)
    newId: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

/**
 * N本が揃うまで全員を止め、揃ったら同じタイミングで進ませる関門。
 *
 * 素のPromise.allだけでは、c.req.formData()などが通るマイクロタスク数が揃わず、
 * 1本目が先に走り切ってしまう。その場合は壊れた「数えてから入れる」実装でも
 * [201, 402, 402]になり、同時実行の穴を再現できないため、確保直前で明示的に揃える。
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

/** JPEGとして通るだけの最小のバイト列(SOIマーカー + APP0)。 */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/**
 * multipart/form-data のセッション作成リクエストを組み立てる。
 *
 * `problemPhoto` は §4-1 の2枚目(教科書・問題集の紙面)。**任意**なので、
 * 既定では付けない — 「2枚必須にしない」が既定の経路で守られていることが、
 * ここに何も渡さないテストがすべて通ることで示される。
 */
export function createSessionForm(
  meta: Record<string, unknown> = {},
  options: { problemPhoto?: File } = {},
): FormData {
  const form = new FormData();
  // 先頭はJPEGのマジックナンバー。中身で形式を判定するので、ここが
  // ただのダミーバイトだと「読み取れない写真」として弾かれる。
  form.set(sessionPhotoParts.notes, new File([JPEG_BYTES], "note.jpg", { type: "image/jpeg" }));
  if (options.problemPhoto) form.set(sessionPhotoParts.problem, options.problemPhoto);
  form.set("meta", JSON.stringify({ kind: "new", locale: "ja", ...meta }));
  return form;
}

/** 問題の写真(2枚目)。中身はノートと同じダミーで、扱いの違いだけを見る。 */
export function problemPhotoFile(type = "image/jpeg"): File {
  return new File([JPEG_BYTES], "problem.jpg", { type });
}
