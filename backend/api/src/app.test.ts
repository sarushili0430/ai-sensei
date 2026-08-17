import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { testBindings, testDeviceId, testServices } from "./test-support.ts";

const app = createApp({ services: () => testServices() });

describe("GET /health", () => {
  // develop と production は同じコードなので、URLを取り違えても
  // {"ok":true} だけでは気づけない。デプロイ後のスモークがこの形に依存している
  // (docs/ci/deploy.yml の Smoke check)。
  it("環境名を名乗る", async () => {
    const response = await app.request("/health", {}, testBindings({ ENVIRONMENT: "production" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, environment: "production" });
  });

  it("ENVIRONMENT が無くても落ちない", async () => {
    const response = await app.request("/health", {}, testBindings());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, environment: "unknown" });
  });

  it("デバイスIDを要求しない", async () => {
    const response = await app.request("/health", {}, testBindings());

    expect(response.status).toBe(200);
  });
});

describe("trace_id", () => {
  // ユーザーからの報告と、Workersのログを突き合わせるための唯一の手がかり
  it("成功したリクエストにも付ける", async () => {
    const response = await app.request("/health", {}, testBindings());
    expect(response.headers.get("x-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("失敗したリクエストにも付ける", async () => {
    const response = await app.request(
      "/v1/me/progress",
      { headers: { "x-device-id": "short" } },
      testBindings(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("x-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ブラウザのクライアント(apps/tuner)は expose されていない応答ヘッダを読めない。
  // 落ちても trace_id を拾えないと、ログと突き合わせる手がかりが無くなる。
  it("ブラウザから読めるように expose する", async () => {
    const response = await app.request(
      "/health",
      { headers: { origin: "http://localhost:5273" } },
      testBindings(),
    );
    expect(response.headers.get("access-control-expose-headers")).toContain("x-trace-id");
  });

  it("リクエストごとに変わる", async () => {
    const first = await app.request(
      "/v1/me/progress",
      { headers: { "x-device-id": testDeviceId } },
      testBindings(),
    );
    const second = await app.request(
      "/v1/me/progress",
      { headers: { "x-device-id": testDeviceId } },
      testBindings(),
    );
    expect(first.headers.get("x-trace-id")).not.toBe(second.headers.get("x-trace-id"));
  });
});
