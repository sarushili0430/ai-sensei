/**
 * 授業冒頭の短い一言を、Gemini TTS で同梱 m4a に差し替える。
 *
 * **会話中と同じ声・同じモデル・同じ読み方の指示**で作る(`senpai-voice.ts` から
 * 読む)。ここがずれると、冒頭の一言だけ別人が喋って、そのまま先輩の声に
 * バトンタッチする — いちばん気づきにくく、いちばん台無しになる壊れ方をする。
 *
 * `@google/genai` を足さず素の `fetch` で書いているのは、このスクリプトが
 * リリース前に数回だけ走る生成工程であり、ルートの依存グラフへ持ち込む理由が
 * 無いため(`backend/agent` 側は LiveKit プラグイン経由でSDKを使う)。
 * Gemini が返すのは生PCMなので、ffmpeg で AAC へ焼いて m4a に包む。
 *
 *   node --experimental-strip-types --env-file=backend/agent/.env \
 *     scripts/generate-prerendered-audio.ts
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  defaultGeminiTtsModel,
  defaultGeminiTtsVoice,
  ttsInstructionsForLocale,
} from "../backend/agent/src/senpai-voice.ts";

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

// agent と同じ環境変数を同じ既定値で読む。声はロケールで分かれない(ADR 0008)。
const ttsModel = process.env.GEMINI_TTS_MODEL?.trim() || defaultGeminiTtsModel;
const ttsVoice = process.env.GEMINI_TTS_VOICE?.trim() || defaultGeminiTtsVoice;

const locales = ["ja", "en"] as const;
const repoRoot = resolve(import.meta.dirname, "..");
const outputDir = join(repoRoot, "apps/mobile/assets/audio");

function usage(): string {
  return [
    "プリレンダ音声を Gemini TTS で生成します。",
    "",
    "使い方:",
    "  node --experimental-strip-types --env-file=backend/agent/.env scripts/generate-prerendered-audio.ts",
    "  node --experimental-strip-types scripts/generate-prerendered-audio.ts --list",
    "",
    "必要: GOOGLE_API_KEY, ffmpeg",
  ].join("\n");
}

function listCues(): void {
  for (const cue of prerenderedCueSources) {
    for (const locale of locales) {
      console.log(`${cue.file[locale]}\t${ttsModel}/${ttsVoice}\t${cue.text[locale]}`);
    }
  }
}

/** Gemini が返す生PCM。サンプリングレートは mimeType にしか書かれていない。 */
type SynthesizedPcm = {
  pcm: Uint8Array;
  sampleRate: number;
};

/**
 * `audio/L16;codec=pcm;rate=24000` からサンプリングレートを読む。
 *
 * 既定は現行の24kHz。**取り違えると音は出るが再生速度がずれる**(ffmpeg には
 * ヘッダの無い生PCMを渡すので、こちらの申告がそのまま正になる)ため、
 * 応答が書いてきたときはそれに従う。
 */
function sampleRateOf(mimeType: string): number {
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : 24_000;
}

async function synthesize(text: string, locale: Locale, apiKey: string): Promise<SynthesizedPcm> {
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${ttsModel}:generateContent`,
  );

  // LiveKitプラグインが投げるのと同じ形に揃える(`{指示}:\n"{本文}"`)。
  // 指示を外すと、同じ声・同じモデルでも喋り方だけが会話中とずれる。
  const prompt = `${ttsInstructionsForLocale(locale)}:\n"${text}"`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      // 鍵はクエリ文字列にも置けるが、そこへ書くとシェル履歴とプロキシのログに残る。
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ttsVoice } } },
      },
    }),
  });

  if (!response.ok) {
    // 応答本文に鍵は入らないが、無制限にログへ出さない。モデル名とHTTP状態で
    // 通常の設定ミスは直せ、本文がHTMLでもターミナルを埋めない。
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Gemini TTS が失敗しました: ${response.status} ${detail}`);
  }

  const body = (await response.json()) as {
    candidates?: {
      content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    }[];
  };
  const audio = body.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.mimeType?.startsWith("audio/") === true,
  )?.inlineData;

  // 200 でも音声が付かないことがある(安全フィルタなど)。空の m4a を assets へ
  // 置くより、どのロケールで止まったかを添えて落とす。
  if (audio?.data === undefined) {
    throw new Error(
      `Gemini TTS が音声を返しませんでした(locale=${locale}, model=${ttsModel}, voice=${ttsVoice})`,
    );
  }

  return {
    pcm: Buffer.from(audio.data, "base64"),
    sampleRate: sampleRateOf(audio.mimeType ?? ""),
  };
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
  const rawPath = join(tempDir, `${cue.id}.${locale}.pcm`);
  // 末尾を .m4a にして、ffmpeg が出力コンテナを拡張子から確定できるようにする。
  const stagedPath = join(outputDir, `.${filename}.${process.pid}.tmp.m4a`);
  const outputPath = join(outputDir, filename);

  const { pcm, sampleRate } = await synthesize(cue.text[locale], locale, apiKey);
  await writeFile(rawPath, pcm);
  try {
    await run(process.env.FFMPEG_BIN?.trim() || "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      // Gemini が返すのはヘッダの無い 16bit little-endian モノラルPCM。
      // 形式は入力側で申告するしかないので、Deepgramのときのような `-c:a copy` は使えない。
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      rawPath,
      "-c:a",
      "aac",
      "-b:a",
      "96k",
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
  console.log(`生成: ${basename(outputPath)} (${size} bytes, ${ttsModel}/${ttsVoice})`);
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

  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) throw new Error(`GOOGLE_API_KEY がありません。\n${usage()}`);

  await mkdir(outputDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "ai-sensei-prerender-"));
  try {
    // 同時に8本投げない。リリース前の手動工程なので速さより、失敗したファイル名が
    // 直前の1行で分かり、Gemini のレート制限へ触れにくいことを採る。
    for (const cue of prerenderedCueSources) {
      for (const locale of locales) await generateOne(cue, locale, apiKey, tempDir);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
