import type { D1Database, KVNamespace, R2Bucket } from "./cloudflare.ts";
import type { Bindings, Services } from "./env.ts";
import type { NotificationScheduler } from "./lib/notifications.ts";
import type { PhotoAnalysis, PhotoAnalyzer } from "./lib/photo-analysis.ts";
import { MemoryRepository } from "./repository/memory.ts";

/**
 * テスト用の足場。
 * ネットワークもD1も使わずに、ルートの振る舞いだけを確かめられるようにする。
 */

export const analysisFixture: PhotoAnalysis = {
  subject: "数学",
  summary: "円と直線の位置関係の問題。(1)は交点の個数を求めている。",
  visible_work: ["中心と直線の距離を求めている", "(2)では連立して判別式を使っている"],
  topics: [
    { topic_id: "M2-ZUKEI-ENCHOKU", confidence: 0.92 },
    { topic_id: "M1-NIJI-HANBETSU", confidence: 0.41 },
  ],
  unreadable: [],
  question_seeds: ["方法を変えた理由", "判別式で何がわかるのか"],
};

export function stubAnalyzer(analysis: PhotoAnalysis = analysisFixture): PhotoAnalyzer {
  return {
    async analyze() {
      return analysis;
    },
  };
}

export class RecordingScheduler implements NotificationScheduler {
  readonly scheduled: {
    deviceId: string;
    holeId: string;
    step: number;
    sendAt: string;
    desc: string;
  }[] = [];
  readonly cancelled: string[] = [];

  async schedule(input: {
    deviceId: string;
    holeId: string;
    step: 1 | 2 | 3;
    sendAt: string;
    desc: string;
    daysSince: number;
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
    FREE_SESSION_MAX_SECONDS: "300",
    PREMIUM_SESSION_MAX_SECONDS: "900",
    // テスト出力を1リクエスト1行で埋めない。失敗のログは残す。
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
    analyzer: stubAnalyzer(options.analysis),
    scheduler: new RecordingScheduler(),
    now: () => options.now ?? new Date("2026-08-03T13:24:07.000Z"),
    // テストで安定したIDにする(ses_1, kar_2, ...)
    newId: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

/** JPEGとして通るだけの最小のバイト列(SOIマーカー + APP0)。 */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/** multipart/form-data のセッション作成リクエストを組み立てる。 */
export function createSessionForm(meta: Record<string, unknown> = {}): FormData {
  const form = new FormData();
  // 先頭はJPEGのマジックナンバー。中身で形式を判定するので、ここが
  // ただのダミーバイトだと「読み取れない写真」として弾かれる。
  form.set("photo", new File([JPEG_BYTES], "note.jpg", { type: "image/jpeg" }));
  form.set("meta", JSON.stringify({ kind: "new", locale: "ja", ...meta }));
  return form;
}
