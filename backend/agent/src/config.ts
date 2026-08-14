import { z } from "zod";

/**
 * Settings with defaults. An empty string counts as "unset".
 *
 * Writing `KEY=` in `.env` yields an empty string, not undefined. Plain
 * `z.string().default()` only fills in on undefined, so the empty string flows
 * downstream (into model names, say) and startup succeeds while the API
 * rejects everything - a confusing failure. Absorb it here.
 */
function withDefault(fallback: string): z.ZodType<string> {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().default(fallback),
  ) as z.ZodType<string>;
}

/** The agent's env vars. Validated once at startup, never mid-conversation. */
const configSchema = z.object({
  API_BASE_URL: z.string().url(),
  INTERNAL_API_TOKEN: z.string().min(1),

  /**
   * The LiveKit project URL. Checked not just for emptiness but for being a
   * readable URL.
   *
   * A value with the scheme dropped (`example.livekit.cloud`) makes the
   * framework's `new URL()` throw during worker startup. That exception is
   * swallowed and prints only `closing worker due to error.` - naming neither
   * the bad env var nor that it is about a URL. Check here so it fails by name.
   */
  LIVEKIT_URL: z
    .string()
    .min(1)
    .refine((value) => URL.canParse(value), "URLとして読めません(wss://... の形で入れる)"),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL_CONVERSATION: withDefault("claude-haiku-4-5-20251001"),
  LLM_MODEL_KARTE: withDefault("claude-sonnet-5"),

  /**
   * The model that writes the board (lesson mode). Use a stronger one than for
   * conversation.
   *
   * The 8/16 gate is "one problem taught with a board, reaching 'I get it'"
   * (plan §3-4), which measures board quality, not conversation speed. Both how
   * formulas are split (§3-6b) and how the allowed commands are respected (§3-6)
   * stop the lesson or break rendering when missed.
   *
   * The cost is latency, felt directly as silence before the first step. The
   * opening is covered by pre-rendered audio (§3-2), so quality wins.
   * When swapping models, also confirm the new version accepts
   * `thinking: {type: "disabled"}` in `lesson.ts`.
   */
  LLM_MODEL_BOARD: withDefault("claude-sonnet-5"),

  /** Listening (STT) and speaking (TTS) share a key; one voice vendor (ADR 0003). */
  DEEPGRAM_API_KEY: z.string().min(1),

  /**
   * The senpai's Japanese voice. Part of the character, so pinned by default.
   *
   * The env override exists only for A/B listening. Local and production must
   * never differ (the same senpai would speak in a different voice per
   * environment), so change it here to change it everywhere at once.
   */
  DEEPGRAM_TTS_MODEL_JA: withDefault("aura-2-izanami-ja"),

  /**
   * The English-locale voice.
   *
   * Deepgram bakes the language into the model name, so a Japanese voice cannot
   * speak English (a voice does not take a language argument). `locale=en` is
   * for demos and review, so the default is fine; override only when it matters.
   */
  DEEPGRAM_TTS_MODEL_EN: withDefault("aura-2-andromeda-en"),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Print the reason, not just the name. "missing" and "present but malformed"
    // need completely different fixes, and names alone cannot tell them apart.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}(${issue.message})`)
      .join(", ");
    throw new Error(`agentの環境変数を読めません: ${detail}(.env.example を参照)`);
  }
  return parsed.data;
}
