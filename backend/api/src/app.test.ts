import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { testBindings, testServices } from "./test-support.ts";

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
