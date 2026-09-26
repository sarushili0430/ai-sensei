/**
 * 紹介動画(英語版)の声とBGMを用意する。**映像より先に一度だけ走らせる。**
 *
 * ```bash
 * GOOGLE_API_KEY=... FFMPEG=/path/to/ffmpeg \
 *   node --experimental-strip-types apps/mobile/tool/demo_video/generate_demo_audio.ts
 * ```
 *
 * 出力(`docs/store/demo-video/audio/en/`):
 *   - `<id>.m4a`      声の1本ずつ(ラウドネスを揃えてある)
 *   - `manifest.json` 各音声の長さ(ミリ秒)。映像側はこれを見て間を決める
 *   - `bgm.mp3`       BGM(コミットしない。無ければ incompetech から取ってくる)
 *
 * 声は3人:
 *
 * | id の頭 | 誰 | 声 |
 * | --- | --- | --- |
 * | `senpai-` | 先輩 | **agent と同じモデル・声・読み方の指示**(`backend/agent/src/senpai-voice.ts`)。本番の授業と同じ声 |
 * | `student-` | 生徒 | `Puck` |
 * | `narr-` | ナレーション | `Charon` |
 *
 * 先輩の台詞は板書の fixture(`board-lesson.en.json` の `speech`)をそのまま読む。
 * 板書と声がずれないように、ここで台詞を書き直さない。
 *
 * すでにある音声は作り直さない(無料枠は1日の回数が少ない)。作り直すときは消してから。
 *
 * BGM: "Carefree" Kevin MacLeod (incompetech.com)
 * Licensed under Creative Commons: By Attribution 4.0 License
 * http://creativecommons.org/licenses/by/4.0/
 * **クレジット表記が利用の条件。**動画の締めと README に出している。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultGeminiTtsModel,
  defaultGeminiTtsVoice,
  ttsInstructionsForLocale,
} from "../../../../backend/agent/src/senpai-voice.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const outDir = join(repoRoot, "docs/store/demo-video/audio/en");
const lessonFixture = join(repoRoot, "packages/contract/fixtures/board-lesson.en.json");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

/** 動画で使う板書の手順数(`generate_demo_video.dart` の英語版 `stepCount` と揃える)。 */
const stepCount = 6;

export const bgmUrl = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3";

type Speaker = "senpai" | "student" | "narrator";

type Cue = { id: string; speaker: Speaker; text: string };

/** ナレーション。章の頭で話す。**先輩が話しているあいだは話さない**(映像側で待つ)。 */
const narration: Cue[] = [
  {
    id: "narr-title",
    text: "Meet Katarute. It teaches you until you say “got it” — and then checks back three days later.",
  },
  {
    id: "narr-snap",
    text: "Stuck on a problem? Just snap a photo. Katarute reads the topic and the question for you.",
  },
  {
    id: "narr-learn",
    text: "Then your AI senpai teaches you, right on the board. The math goes on the board. The voice just asks you questions.",
  },
  {
    id: "narr-gotit",
    text: "The lesson only ends when you tap “Got it.” Then one review question is made from that board.",
  },
  {
    id: "narr-later",
    text: "Three days later, your senpai checks back. Just one question — about thirty seconds.",
  },
  {
    id: "narr-answer",
    text: "Type your answer, and the AI grades it. Miss it, and it asks again after one, three, and seven days.",
  },
  {
    id: "narr-keep",
    text: "No scores. No rankings. Just the days you kept going, and the problems you solved.",
  },
  {
    id: "narr-end",
    text: "Katarute. Taught until you say “got it.” Asked again in three days.",
  },
].map((cue) => ({ ...cue, speaker: "narrator" as const }));

const student: Cue[] = [
  { id: "student-reply", speaker: "student", text: "Um… x minus one, times x minus two?" },
];

async function senpaiCues(): Promise<Cue[]> {
  const lesson = JSON.parse(await readFile(lessonFixture, "utf8")) as {
    steps: { index: number; speech: string }[];
  };
  return [
    // 授業冒頭の同梱音声と同じ一言(`scripts/generate-prerendered-audio.ts`)。
    { id: "senpai-opening", speaker: "senpai", text: "Okay, let's take a look at this together." },
    ...lesson.steps.slice(0, stepCount).map((step) => ({
      id: `senpai-step-${step.index}`,
      speaker: "senpai" as const,
      text: step.speech,
    })),
  ];
}

const voices: Record<Speaker, string> = {
  senpai: process.env.GEMINI_TTS_VOICE?.trim() || defaultGeminiTtsVoice,
  student: "Puck",
  narrator: "Charon",
};

function prompt(cue: Cue): string {
  switch (cue.speaker) {
    case "senpai":
      // agent と同じ包み方(`{instructions}:\n"{text}"`)。ここがずれると別人になる。
      return `${ttsInstructionsForLocale("en")}:\n"${cue.text}"`;
    case "student":
      return (
        "Read this aloud in English as a high school student answering a tutor out loud, " +
        `a little unsure but getting it right. Do not omit, add, or answer anything:\n"${cue.text}"`
      );
    case "narrator":
      return (
        "Read this aloud in English as a warm, friendly narrator of a short app demo video. " +
        "Clear and natural, gently upbeat, never salesy. Do not omit, add, or change anything:\n" +
        `"${cue.text}"`
      );
  }
}

/**
 * TTSのモデル。既定は agent と同じ。
 *
 * **無料枠は1日10回**(2026-09 時点)。使い切ったら `GEMINI_TTS_MODEL` で別のモデルに
 * 逃がす(同じ声名なら同じ声になる)。ただし**同じ話者の中でモデルを混ぜない** —
 * 途中の1本だけ声の質が変わる。混ぜそうなら、その話者の音声を消して全部作り直す。
 */
const model = process.env.GEMINI_TTS_MODEL?.trim() || defaultGeminiTtsModel;

async function synthesize(cue: Cue, apiKey: string): Promise<{ pcm: Buffer; rate: number }> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt(cue) }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[cue.speaker] } },
            },
          },
        }),
      },
    );
    if (response.status === 429 && attempt <= 8) {
      // 無料枠の分あたり上限。言われた秒数だけ待って投げ直す。
      const body = await response.text();
      const wait = Number(/"retryDelay":\s*"(\d+)/.exec(body)?.[1] ?? "20");
      console.log(`  429: ${wait + 2}s 待って投げ直します(${attempt}回目)`);
      await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
      continue;
    }
    if (!response.ok) {
      throw new Error(`TTS が失敗しました(${cue.id}): ${response.status} ${(await response.text()).slice(0, 400)}`);
    }
    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
    };
    const audio = body.candidates?.[0]?.content?.parts?.find((p) =>
      p.inlineData?.mimeType?.startsWith("audio/"),
    )?.inlineData;
    if (audio?.data === undefined) {
      // まれに文字だけ返ってくる。同じ文で投げ直せば通る。
      if (attempt <= 3) continue;
      throw new Error(`TTS が音声を返しませんでした(${cue.id})`);
    }
    const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? "")?.[1] ?? "24000");
    return { pcm: Buffer.from(audio.data, "base64"), rate };
  }
}

async function run(args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise(stderr) : reject(new Error(`ffmpeg: ${code}\n${stderr.slice(-800)}`)),
    );
  });
}

/** 生PCM → 前後の無音を詰め、ラウドネスを揃えて m4a に焼く。 */
async function encode(pcm: Buffer, rate: number, out: string): Promise<void> {
  const raw = `${out}.pcm`;
  await writeFile(raw, pcm);
  try {
    await run([
      "-y",
      "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw,
      "-af",
      [
        // 頭とお尻の無音を落とす(間は映像側で持つ)
        "silenceremove=start_periods=1:start_threshold=-45dB",
        "areverse",
        "silenceremove=start_periods=1:start_threshold=-45dB",
        "areverse",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "aresample=48000",
      ].join(","),
      "-c:a", "aac", "-b:a", "128k",
      out,
    ]);
  } finally {
    await rm(raw, { force: true });
  }
}

async function durationMs(file: string): Promise<number> {
  const log = await run(["-i", file, "-f", "null", "-"]).catch((e: Error) => e.message);
  const all = [...log.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = all.at(-1);
  if (last === undefined) throw new Error(`長さを測れませんでした: ${file}`);
  return Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000);
}

async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  await mkdir(outDir, { recursive: true });

  const cues = [...narration, ...student, ...(await senpaiCues())];
  const manifestPath = join(outDir, "manifest.json");
  const previous = existsSync(manifestPath)
    ? (JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, { model?: string }>)
    : {};
  const manifest: Record<
    string,
    { speaker: Speaker; model: string; voice: string; text: string; ms: number }
  > = {};

  for (const cue of cues) {
    const file = join(outDir, `${cue.id}.m4a`);
    // 1回目(flash)で作ったナレーションと生徒の声は manifest が無いので既定のモデルで記録する。
    let usedModel = previous[cue.id]?.model ?? defaultGeminiTtsModel;
    if (!existsSync(file)) {
      usedModel = model;
      if (!apiKey) throw new Error("GOOGLE_API_KEY がありません(未生成の音声があります)");
      console.log(`${cue.id} (${voices[cue.speaker]}): ${cue.text}`);
      const { pcm, rate } = await synthesize(cue, apiKey);
      await encode(pcm, rate, file);
    }
    manifest[cue.id] = {
      speaker: cue.speaker,
      model: usedModel,
      voice: voices[cue.speaker],
      text: cue.text,
      ms: await durationMs(file),
    };
    // 1本ごとに書く(途中で上限に当たっても、できた分の記録を残す)。
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const bgm = join(outDir, "bgm.mp3");
  if (!existsSync(bgm)) {
    console.log(`BGM: ${bgmUrl}`);
    const response = await fetch(bgmUrl);
    if (!response.ok) throw new Error(`BGM を取得できませんでした: ${response.status}`);
    await writeFile(bgm, Buffer.from(await response.arrayBuffer()));
  }
  console.log(`done: ${Object.keys(manifest).length} voices → ${outDir}`);
}

await main();
