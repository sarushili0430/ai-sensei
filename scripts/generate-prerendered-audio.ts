/**
 * Regenerates the short opening lines of a lesson as bundled m4a via Deepgram.
 *
 * It uses the same `/v1/speak`, `Token` auth and model defaults as
 * `deepgram.TTS` in backend/agent. Only the output differs: AAC for storage rather
 * than PCM for real-time conversation, wrapped into an m4a container with ffmpeg.
 * No second SDK is added as a dependency because this script is a generation step
 * that runs a handful of times before a release, with no reason to enter the
 * runtime dependency graph.
 *
 *   node --experimental-strip-types --env-file=backend/agent/.env \
 *     scripts/generate-prerendered-audio.ts
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type Locale = "ja" | "en";

type CueSource = {
  id: string;
  text: Record<Locale, string>;
  file: Record<Locale, string>;
};

/** Authoritative for the wording and output paths. One-to-one with Flutter's `PrerenderedAudioCue`. */
export const prerenderedCueSources = [
  {
    id: "lesson_opening",
    text: {
      ja: "なるほど、じゃあ一緒に見てみようか。",
      en: "Okay, let's take a look at this together.",
    },
    file: { ja: "lesson_opening.ja.m4a", en: "lesson_opening.en.m4a" },
  },
] as const satisfies readonly CueSource[];

const models: Record<Locale, string> = {
  // The same defaults as backend/agent/src/config.ts. To change the voice, override both with the same env var.
  ja: process.env.DEEPGRAM_TTS_MODEL_JA?.trim() || "aura-2-izanami-ja",
  en: process.env.DEEPGRAM_TTS_MODEL_EN?.trim() || "aura-2-andromeda-en",
};

const locales = ["ja", "en"] as const;
const repoRoot = resolve(import.meta.dirname, "..");
const outputDir = join(repoRoot, "apps/mobile/assets/audio");

function usage(): string {
  return [
    "プリレンダ音声を Deepgram で生成します。",
    "",
    "使い方:",
    "  node --experimental-strip-types --env-file=backend/agent/.env scripts/generate-prerendered-audio.ts",
    "  node --experimental-strip-types scripts/generate-prerendered-audio.ts --list",
    "",
    "必要: DEEPGRAM_API_KEY, ffmpeg",
  ].join("\n");
}

function listCues(): void {
  for (const cue of prerenderedCueSources) {
    for (const locale of locales) {
      console.log(`${cue.file[locale]}\t${models[locale]}\t${cue.text[locale]}`);
    }
  }
}

async function synthesize(text: string, model: string, apiKey: string): Promise<Uint8Array> {
  const url = new URL("https://api.deepgram.com/v1/speak");
  url.searchParams.set("model", model);
  url.searchParams.set("encoding", "aac");
  url.searchParams.set("sample_rate", "24000");
  // Receive raw audio as the LiveKit plugin does. m4a packaging is done solely by ffmpeg below.
  url.searchParams.set("container", "none");
  url.searchParams.set("mip_opt_out", "false");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    // The response body carries no key, but do not log it without bound. The model name
    // and the HTTP status fix ordinary misconfiguration, and an HTML body will not fill
    // the terminal.
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Deepgram TTS が失敗しました: ${response.status} ${detail}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} が失敗しました(code=${String(code)}, signal=${signal ?? "-"})`));
    });
  });
}

async function generateOne(
  cue: (typeof prerenderedCueSources)[number],
  locale: Locale,
  apiKey: string,
  tempDir: string,
): Promise<void> {
  const filename = cue.file[locale];
  const rawPath = join(tempDir, `${cue.id}.${locale}.aac`);
  // End the name in .m4a so ffmpeg settles the output container from the extension.
  const stagedPath = join(outputDir, `.${filename}.${process.pid}.tmp.m4a`);
  const outputPath = join(outputDir, filename);

  const audio = await synthesize(cue.text[locale], models[locale], apiKey);
  await writeFile(rawPath, audio);
  try {
    await run(process.env.FFMPEG_BIN?.trim() || "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "aac",
      "-i",
      rawPath,
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      stagedPath,
    ]);

    // Swap in one finished file atomically. If the API or ffmpeg dies partway, the
    // existing asset never becomes a 0-byte or half-written m4a.
    await rename(stagedPath, outputPath);
  } finally {
    // Traces of a failed ffmpeg run left under assets would be bundled by Flutter's
    // directory-based bundling, so clean up on success too.
    await rm(stagedPath, { force: true });
  }
  const size = (await readFile(outputPath)).byteLength;
  console.log(`生成: ${basename(outputPath)} (${size} bytes, ${models[locale]})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  if (args.includes("--list")) {
    listCues();
    return;
  }
  if (args.length > 0) throw new Error(`未対応の引数です: ${args.join(" ")}\n${usage()}`);

  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!apiKey) throw new Error(`DEEPGRAM_API_KEY がありません。\n${usage()}`);

  await mkdir(outputDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "ai-sensei-prerender-"));
  try {
    // Do not fire eight at once. This is a manual pre-release step, so knowing which
    // file failed from the line just above, and staying clear of Deepgram's rate limit,
    // beats speed.
    for (const cue of prerenderedCueSources) {
      for (const locale of locales) await generateOne(cue, locale, apiKey, tempDir);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
