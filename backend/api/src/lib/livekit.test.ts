import { describe, expect, it } from "vitest";
import { createLiveKitToken, verifyJwt } from "./livekit.ts";

const secret = "test-secret-value-for-hmac";
const now = new Date("2026-08-03T13:24:07.000Z");

describe("createLiveKitToken", () => {
  it("署名が検証でき、LiveKitのgrantが入っている", async () => {
    const token = await createLiveKitToken({
      apiKey: "APItestkey",
      apiSecret: secret,
      identity: "device-1",
      room: "ses_1",
      ttlSeconds: 420,
      now,
    });

    const claims = await verifyJwt(token, secret);
    expect(claims?.["iss"]).toBe("APItestkey");
    expect(claims?.["sub"]).toBe("device-1");
    expect(claims?.["video"]).toEqual({
      room: "ses_1",
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
  });

  it("有効期限はセッション上限+猶予にする", async () => {
    const token = await createLiveKitToken({
      apiKey: "APItestkey",
      apiSecret: secret,
      identity: "device-1",
      room: "ses_1",
      ttlSeconds: 420,
      now,
    });
    const claims = await verifyJwt(token, secret);
    const issuedAt = Math.floor(now.getTime() / 1000);
    expect(claims?.["exp"]).toBe(issuedAt + 420);
    // Back-date nbf to allow for clock skew
    expect(claims?.["nbf"]).toBe(issuedAt - 10);
  });

  it("metadataに会話の文脈を載せられる", async () => {
    const metadata = JSON.stringify({ allowed_topic_ids: ["M2-ZUKEI-ENCHOKU"] });
    const token = await createLiveKitToken({
      apiKey: "APItestkey",
      apiSecret: secret,
      identity: "device-1",
      room: "ses_1",
      ttlSeconds: 60,
      metadata,
      now,
    });
    const claims = await verifyJwt(token, secret);
    expect(claims?.["metadata"]).toBe(metadata);
  });

  // Named workers are excluded from auto dispatch. Without the token calling them, nobody joins.
  it("agentを渡すと、ルーム作成時のディスパッチがトークンに載る", async () => {
    const metadata = JSON.stringify({ session_id: "ses_1" });
    const token = await createLiveKitToken({
      apiKey: "APItestkey",
      apiSecret: secret,
      identity: "device-1",
      room: "ses_1",
      ttlSeconds: 420,
      metadata,
      agent: { name: "ai-sensei-senpai", metadata },
      now,
    });

    const claims = await verifyJwt(token, secret);
    expect(claims?.["roomConfig"]).toEqual({
      agents: [{ agent_name: "ai-sensei-senpai", metadata }],
    });
  });

  it("agentを渡さなければroomConfigは載らない(自動ディスパッチ)", async () => {
    const token = await createLiveKitToken({
      apiKey: "APItestkey",
      apiSecret: secret,
      identity: "device-1",
      room: "ses_1",
      ttlSeconds: 420,
      now,
    });
    const claims = await verifyJwt(token, secret);
    expect(claims?.["roomConfig"]).toBeUndefined();
  });

  it("別の秘密鍵では検証に失敗する", async () => {
    const token = await createLiveKitToken({
      apiKey: "APItestkey",
      apiSecret: secret,
      identity: "device-1",
      room: "ses_1",
      ttlSeconds: 60,
      now,
    });
    expect(await verifyJwt(token, "another-secret")).toBeNull();
  });

  it("形の壊れたトークンはnull", async () => {
    expect(await verifyJwt("not-a-jwt", secret)).toBeNull();
  });
});
