import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { testBindings, testDeviceId, testServices } from "./test-support.ts";

const app = createApp({ services: () => testServices() });

describe("GET /health", () => {
  // develop and production run the same code, so {"ok":true} alone cannot catch a
  // mixed-up URL. The post-deploy smoke test depends on this shape
  // (Smoke check in docs/ci/deploy.yml).
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
  // The only handle for matching a user report against the Workers logs
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
