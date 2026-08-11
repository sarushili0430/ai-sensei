/**
 * 授業冒頭の短い一言を、Deepgram で同梱 m4a に差し替える。
 *
 * backend/agent の `deepgram.TTS` と同じ `/v1/speak`、`Token` 認証、モデル既定値を
 * 使う。違うのは出力だけで、リアルタイム会話の PCM ではなく保存向け AAC を受け、
 * ffmpeg で m4a コンテナに包む。SDKをもう1本依存させないのは、このスクリプトが
 * リリース前に数回だけ走る生成工程であり、実行時の依存グラフへ持ち込む理由が無いため。
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

/** 文言・出力先の正。Flutter 側の `PrerenderedAudioCue` と1対1で対応する。 */
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
  // backend/agent/src/config.ts と同じ既定。声を変えるなら両方を同じ環境変数で上書きする。
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
  // LiveKit plugin と同じく生の音声を受ける。m4a 化は下の ffmpeg に一本化する。
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
    // 応答本文に鍵は入らないが、無制限にログへ出さない。モデル名とHTTP状態で
    // 通常の設定ミスは直せ、本文がHTMLでもターミナルを埋めない。
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
  // 末尾を .m4a にして、ffmpeg が出力コンテナを拡張子から確定できるようにする。
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

    // 完成した1ファイルだけを原子的に差し替える。API・ffmpeg が途中で落ちても、
    // 既存アセットを0バイトや途中までの m4a にしない。
    await rename(stagedPath, outputPath);
  } finally {
    // ffmpeg が途中で失敗した痕跡を assets 配下へ残すと、ディレクトリ指定の
    // Flutter bundle がその壊れた一時ファイルまで同梱するため、成功時も含めて掃除する。
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
    // 同時に8本投げない。リリース前の手動工程なので速さより、失敗したファイル名が
    // 直前の1行で分かり、Deepgram のレート制限へ触れにくいことを採る。
    for (const cue of prerenderedCueSources) {
      for (const locale of locales) await generateOne(cue, locale, apiKey, tempDir);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
