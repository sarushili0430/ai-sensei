/**
 * backend/api を叩く。**アプリ(`apps/mobile/lib/src/api/api_client.dart`)と同じ形で送る。**
 *
 * 認証は匿名デバイスID(`X-Device-Id`)だけ。写真は multipart で、
 * **ノートと問題は別のパート**(`packages/contract` の `sessionPhotoParts`。
 * ノートはR2に保存され、問題の紙面は解析後に破棄される)。
 */

/** APIのエラー(`apiErrorSchema`)。`code` で分岐できるようにして投げる。 */
export class ApiError extends Error {
  constructor(status, body, traceId) {
    const code = body?.error?.code ?? "unknown";
    super(`${code}: ${body?.error?.message ?? `HTTP ${status}`}`);
    this.status = status;
    this.code = code;
    this.traceId = traceId;
    this.body = body;
  }
}

export class ApiClient {
  constructor(baseUrl, deviceId) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.deviceId = deviceId;
  }

  get headers() {
    return { "x-device-id": this.deviceId };
  }

  async health() {
    const response = await fetch(`${this.baseUrl}/health`);
    return this.#read(response);
  }

  /**
   * 写真を送ってセッションを作る。**返るのは解析の結果だけで、部屋の鍵は入っていない。**
   * 今日の1回を使うのは {@link startSession}(会話が始まったとき)。
   */
  async createSession({ notesPhoto, problemPhoto, locale, schoolStage, topicIds }) {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        kind: "new",
        locale,
        school_stage: schoolStage,
        ...(topicIds?.length ? { topic_ids: topicIds } : {}),
      }),
    );
    if (notesPhoto) form.set("photo", notesPhoto, notesPhoto.name);
    if (problemPhoto) form.set("problem_photo", problemPhoto, problemPhoto.name);

    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: this.headers,
      body: form,
    });
    return this.#read(response);
  }

  /** チップUIで外した単元を反映する(**解析し直さない**)。 */
  async updateTopics(sessionId, topicIds, locale) {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/topics`, {
      method: "PATCH",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ locale, topic_ids: topicIds }),
    });
    return this.#read(response);
  }

  /** 会話を始める。**ここで今日の1回を使う。**部屋の鍵はこの応答にしかない。 */
  async startSession(sessionId, locale) {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/start`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ locale }),
    });
    return this.#read(response);
  }

  /** カルテを取りに行く。生成中は 202 が返るので `null`。 */
  async fetchResult(sessionId) {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/result`, {
      headers: this.headers,
    });
    if (response.status === 202) return null;
    return this.#read(response);
  }

  async #read(response) {
    const traceId = response.headers.get("x-trace-id");
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, body, traceId);
    return { body, traceId };
  }
}

/**
 * LiveKitトークンの `metadata` を取り出す。
 *
 * **agent に渡っている会話文脈そのもの**(`packages/contract` の `sessionMetadataSchema`)で、
 * プロンプトの穴埋めにそのまま流れ込む。ここがチューニングの一次資料になる —
 * 板書がおかしいとき、プロンプトが悪いのか渡している文脈が悪いのかは、
 * これを見ないと切り分けられない。
 *
 * 署名は確かめない(**中身を読むだけ**。検証はサーバの仕事)。
 */
export function decodeTokenMetadata(token) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const claims = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))),
  );
  if (typeof claims.metadata !== "string") return { claims, metadata: null };
  try {
    return { claims, metadata: JSON.parse(claims.metadata) };
  } catch {
    return { claims, metadata: claims.metadata };
  }
}
