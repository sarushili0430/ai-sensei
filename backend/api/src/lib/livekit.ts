/**
 * Issues the LiveKit join token (JWT / HS256).
 *
 * server-sdk-js depends on Node APIs in places, so on Workers we build a minimal
 * JWT ourselves with WebCrypto. What is signed follows LiveKit's grant spec.
 */

export type VideoGrant = {
  room: string;
  roomJoin: boolean;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
};

/**
 * How the agent is called into the room.
 *
 * When the LiveKit worker is registered *with a name*, auto dispatch does not
 * fire. In that case, unless the room's creator says "call this agent", the room
 * stays open with nobody in it (the app sits on "listening").
 */
export type AgentDispatch = {
  /** The worker's `agentName` (LIVEKIT_AGENT_NAME). */
  name: string;
  /** Context passed to the job. The same content as participant metadata. */
  metadata?: string;
};

export type TokenInput = {
  apiKey: string;
  apiSecret: string;
  identity: string;
  room: string;
  /** Lifetime in seconds. Session cap plus grace. */
  ttlSeconds: number;
  /** Context for the agent (photo interpretation, allowed topics, question policy). */
  metadata?: string;
  /** Passed only for workers that need explicit dispatch. */
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
    // LiveKit checks nbf, so back-date slightly to allow for clock skew
    nbf: issuedAt - 10,
    exp: issuedAt + input.ttlSeconds,
    jti: input.identity,
    video: grant,
  };
  if (input.metadata !== undefined) payload["metadata"] = input.metadata;

  // Call the agent the moment the room is created. Riding on the token means
  // dispatch always fires when the app connects (no separate API call).
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

/** Used by tests and by the agent's callback verification. */
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
