/**
 * LiveKitの参加トークン(JWT / HS256)を発行する。
 *
 * server-sdk-js はNode APIに依存する箇所があるので、Workersでは
 * WebCryptoで最小限のJWTを自前で組む。署名対象はLiveKitのgrant仕様に沿う。
 */

export type VideoGrant = {
  room: string;
  roomJoin: boolean;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
};

/**
 * ルームに後輩(agent)を呼ぶ指定。
 *
 * LiveKitのワーカーが**名前つき**で登録されていると、自動ディスパッチは効かない。
 * その場合、ルームを作る側が「このエージェントを呼ぶ」と言わないと、
 * 部屋は誰も来ないまま開き続ける(アプリからは「聞いています」のまま止まる)。
 */
export type AgentDispatch = {
  /** ワーカーの `agentName`(LIVEKIT_AGENT_NAME)。 */
  name: string;
  /** ジョブに渡す文脈。参加者metadataと同じものを載せる。 */
  metadata?: string;
};

export type TokenInput = {
  apiKey: string;
  apiSecret: string;
  identity: string;
  room: string;
  /** 有効期限(秒)。セッション上限 + 猶予にする。 */
  ttlSeconds: number;
  /** エージェントに渡す文脈(写真の解釈・許可トピック・質問方針)。 */
  metadata?: string;
  /** 明示ディスパッチが要るワーカーのときだけ渡す。 */
  agent?: AgentDispatch;
  now?: Date;
};

export async function createLiveKitToken(input: TokenInput): Promise<string> {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const grant: VideoGrant = {
    room: input.room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };

  const payload: Record<string, unknown> = {
    iss: input.apiKey,
    sub: input.identity,
    // LiveKitはnbfを見るので、時計ずれを見込んで少し前に倒す
    nbf: issuedAt - 10,
    exp: issuedAt + input.ttlSeconds,
    jti: input.identity,
    video: grant,
  };
  if (input.metadata !== undefined) payload["metadata"] = input.metadata;

  // ルームが作られる瞬間に後輩を呼ぶ。トークンに載せるので、
  // アプリが接続した時点で必ずディスパッチが走る(別APIを叩かなくてよい)。
  if (input.agent) {
    payload["roomConfig"] = {
      agents: [
        {
          agent_name: input.agent.name,
          ...(input.agent.metadata === undefined ? {} : { metadata: input.agent.metadata }),
        },
      ],
    };
  }

  return signJwt(payload, input.apiSecret);
}

export async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** テストと、agentからの折り返し検証で使う。 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(signature),
    new TextEncoder().encode(`${header}.${body}`),
  );
  if (!valid) return null;

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as Record<string, unknown>;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
