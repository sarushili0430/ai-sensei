import type { Locale } from "@ai-sensei/contract";
import type { LlmClient } from "../karte.ts";
import { type LessonTurn, renderLessonRecap } from "../senpai.ts";
import type { EvalScenario } from "./scenario.ts";

/**
 * 生徒シミュレータ。**L2(授業の往復)の相手役**をLLMで作る。
 *
 * 本番の相手は人間で、その発話はSTTを通って `StudentUtterances` に入る。
 * ハーネスにはマイクもSTTも無いので、**同じ口から入る文字列**をここで作る
 * (`lesson-loop.ts` の【生徒の発話は2種類とも同じ口から入る】)。
 *
 * だから作るのは「正しい答え」ではなく、**声で喋った1発話**:
 *
 *   - 短い(1〜2文)。長い説明を返すと、板書プロンプトが受け取る文脈が
 *     人間の授業より豊かになり、**続きの手順が実際より良く出る**
 *   - 記号を使わない。STTは `x^2` を起こさない(「エックスの2乗」になる)。
 *     記号入りの答えを渡すと、音声正規化(`normalizeMathSpeech`)の経路が
 *     一度も通らないまま「うまくいった」ことになる
 *
 * ペルソナのプロンプトは**ロケールごとに別本**にしてある。片方の言語の本文に
 * もう片方の例文を混ぜると、モデルはそこだけ別の言語で応答しはじめる
 * (`prompts/README.md` と `render.ts` の `phrases` と同じ理屈)。
 */

export type StudentPersona = "cooperative" | "stuck" | "silent";

/** CLIの `--persona` の照合に使う。**綴りの正本はここだけ。** */
export const studentPersonas: readonly StudentPersona[] = ["cooperative", "stuck", "silent"];

export function isStudentPersona(value: string): value is StudentPersona {
  return studentPersonas.some((persona) => persona === value);
}

/**
 * 生徒が喋る場面。**同じペルソナでも、聞かれていることが違う。**
 *
 *   - `lesson`     … 授業の途中の問いかけへの答え(「まず何する?」)
 *   - `teach_back` … 教え返し。自分の言葉で説明する側に回る
 */
export type StudentPhase = "lesson" | "teach_back";

export type EvalStudent = {
  /**
   * レコードの `meta.persona` に入る札。**生徒自身が持つ。**
   *
   * ランナーの引数で別に受け取ると、渡し忘れたときに
   * 「cooperative と書いてあるが実際は scripted だった」試行が保存できてしまう。
   */
  readonly persona: string;
  /**
   * 先輩の問いかけ(直近の授業の列)を受けて、生徒の発話を返す。
   *
   * `null` は**無言**。ランナーはこれを積まず、`runLessonLoop` の答え待ちの
   * タイムアウトに任せる(そこで `studentSilenceMarker` が授業の列に残る)。
   */
  answer(turnsSoFar: readonly LessonTurn[], phase: StudentPhase): Promise<string | null>;
};

/** 1発話ぶんの上限。2文の指示に従わなかったときの安全弁。 */
export const studentMaxTokens = 300;

/**
 * 生徒の1発話の上限(文字)。**STTが起こす長さの帯に寄せる。**
 *
 * 溢れたぶんは切る。長い答えをそのまま渡すと、次のパスの継続指示
 * (`lessonContinuationInstruction`)が生徒の作文で埋まり、板書の続きが
 * 「人間の授業では起きない文脈」から書かれることになる。
 */
export const studentUtteranceMaxLength = 200;

/**
 * 生徒に見せる直近の手順数。
 *
 * 全部渡さないのは、`renderLessonRecap` が溢れたときに**先頭を残す**ため
 * (授業の要約としては正しいが、生徒に渡すと**直前の問いかけが落ちる**)。
 * 末尾から切り出して渡せば、聞かれたことが必ず入る。
 */
export const studentContextTurns = 12;

const STUDENT_ROLE: Record<Locale, string> = {
  ja: [
    "あなたは高校生の生徒です。先輩が黒板を使って、いま目の前の問題を教えてくれています。",
    "あなたは教わる側で、先輩役ではありません。解説したり、板書を書いたりしません。",
    "知らないことを知っているふりはしません。思っていることをそのまま短く言います。",
  ].join("\n"),
  en: [
    "You are a high-school student. A senpai is teaching you the problem in front of you, using a board.",
    "You are the one being taught. You never explain like a teacher and never write on the board.",
    "You do not pretend to know things you do not know. You say what you actually think, briefly.",
  ].join("\n"),
};

const STUDENT_STYLE: Record<Locale, string> = {
  ja: [
    "## 話し方(声で喋っています)",
    "",
    "- 1〜2文で短く。長い説明はしません。",
    "- 記号は使いません。数式は口で言う形にします(「エックスの2乗」「エックスは2」「ルート5」)。",
    "- 言い淀み(「えっと」「うーん」)を入れてかまいません。読点は少なめ。",
    "- 聞かれたことにだけ答えます。次の話題を自分から始めません。",
  ].join("\n"),
  en: [
    "## How you talk (you are speaking out loud)",
    "",
    "- One or two short sentences. No long explanations.",
    '- No symbols. Say the math out loud ("x squared", "x is two", "root five").',
    '- Fillers like "um" or "hmm" are fine. Keep the punctuation light.',
    "- Answer only what you were asked. Do not start a new topic yourself.",
  ].join("\n"),
};

/**
 * ペルソナ。**測りたい壊れ方ごとに1本。**
 *
 *   - `cooperative` … 答えが返る授業。往復が最後まで回る素の成績が見える
 *   - `stuck`       … 詰まる生徒。約束4(責めない)と「詰まったとき」の手順が効くか
 *   - `silent`      … 返事が来ない。答え待ちのタイムアウトと
 *                     `studentSilenceMarker` の経路を通す(下の {@link createLlmStudent})
 */
const PERSONA_TRAITS: Record<Locale, Record<StudentPersona, string>> = {
  ja: {
    cooperative:
      "素直に考えて答えます。聞かれたことには必ず何か返します。半分くらいは合っていて、教わった直後のことなら自分の言葉で言い直せます。",
    stuck:
      "途中で詰まります。用語を取り違えたり、手順の順番を逆に言ったりします。「わからない」「そこが分からない」とそのまま言ってかまいません。正解を作りに行かないこと。",
    silent: "気が乗らず、ぼそっと短く返します。1文だけ。",
  },
  en: {
    cooperative:
      "You think it through and answer. You always give something back. You are right about half the time, and you can restate what you were just taught in your own words.",
    stuck:
      'You get stuck partway. You mix up terms and put steps in the wrong order. Saying "I don\'t know" or "that\'s the part I don\'t get" is fine. Do not manufacture the right answer.',
    silent: "You are not really in the mood. You mumble one short sentence.",
  },
};

const PROBLEM_HEADINGS: Record<Locale, { problem: string; work: string }> = {
  ja: { problem: "## いま教わっている問題", work: "### あなたのノートに書いてあること" },
  en: {
    problem: "## The problem you are being taught",
    work: "### What is already in your notebook",
  },
};

/**
 * ペルソナ1本ぶんのsystem。**問題文はシナリオの値をそのまま貼る。**
 *
 * 手で書き直すと、空欄のプレースホルダ(「(ノートの写真なし)」)がずれて、
 * 板書プロンプトが見ている入力と生徒が見ている入力が食い違う。
 */
function studentSystemPrompt(
  persona: StudentPersona,
  locale: Locale,
  scenario: EvalScenario,
): string {
  const headings = PROBLEM_HEADINGS[locale];
  return [
    STUDENT_ROLE[locale],
    "",
    headings.problem,
    "",
    scenario.context.problem_text,
    "",
    headings.work,
    "",
    scenario.context.visible_work,
    "",
    STUDENT_STYLE[locale],
    "",
    locale === "en" ? "## How you are doing today" : "## あなたの様子",
    "",
    PERSONA_TRAITS[locale][persona],
  ].join("\n");
}

/**
 * 「何が起きたか」を渡して、次の1発話だけを頼む。
 *
 * 授業の列の書き下しは `renderLessonRecap` に任せる — ロール名(「ユーザー:」/
 * "Student:")を自分で書くと、`senpai.ts` 側の綴りが変わったときに片方だけ古くなる。
 */
const STUDENT_INSTRUCTION: Record<Locale, (recap: string, phase: StudentPhase) => string> = {
  ja: (recap, phase) =>
    [
      "ここまでのやりとりです。番号つきの行は先輩が板書に書いて読み上げた手順、「ユーザー:」の行はあなたが言ったことです。",
      "",
      recap,
      "",
      phase === "teach_back"
        ? "先輩に「自分の言葉で説明して」と言われています。いま教わったことを、思い出せる範囲で説明してください。"
        : "先輩の直前の問いかけへの返事を1つだけ返してください。",
      "- セリフだけを書きます(名前・かぎ括弧・説明・記号は付けない)。",
      "- 1〜2文。分からないところは分からないと言ってかまいません。",
    ].join("\n"),
  en: (recap, phase) =>
    [
      'This is what has happened so far. Numbered lines are steps the senpai wrote on the board and read out; "Student:" lines are things you said.',
      "",
      recap,
      "",
      phase === "teach_back"
        ? "The senpai asked you to explain it in your own words. Explain what you were just taught, as far as you can remember it."
        : "Reply to the question the senpai just asked. One reply only.",
      "- Write only the line you say (no name, no quotation marks, no commentary, no symbols).",
      "- One or two sentences. Saying you do not know a part is fine.",
    ].join("\n"),
};

/** 名前の札。モデルは頼まなくても「生徒:」を付けてくることがある。 */
const ROLE_PREFIX = /^(?:生徒|ユーザー|先輩|Student|Senpai|User)\s*[:：]\s*/;

/** 前後のかぎ括弧・引用符。全角の引用符はコードポイントで書く(半角に潰れても気づけるように)。 */
const QUOTE_CHARS = "「」『』\"'“”‘’";
const WRAPPING_QUOTES = new RegExp(`^[${QUOTE_CHARS}]+|[${QUOTE_CHARS}]+$`, "g");

/**
 * モデルの出力を、**声に載る1行**へ畳む。生徒にも教え返しの先輩にも使う。
 *
 * 改行を潰すのは、STTが1発話を1行で起こすから。ここで残すと、レコードの
 * `teach_back.messages` に箇条書きが入り、**音声では鳴らない形**を採点することになる。
 * 空になったら `null`(生徒なら無言、先輩なら会話の打ち切り)。
 */
export function asSpokenLine(raw: string, maxLength = studentUtteranceMaxLength): string | null {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const spoken = oneLine.replace(ROLE_PREFIX, "").replace(WRAPPING_QUOTES, "").trim();
  return spoken.length === 0 ? null : spoken.slice(0, maxLength);
}

export type CreateLlmStudentOptions = {
  /** `karte.ts` の `createAnthropicClient`(非ストリーミング)。 */
  llm: LlmClient;
  persona: StudentPersona;
  locale: Locale;
  /** 問題文とノートの読み取りを生徒にも見せる。**板書プロンプトと同じ値**を使う。 */
  scenario: EvalScenario;
};

export function createLlmStudent(options: CreateLlmStudentOptions): EvalStudent {
  const { llm, persona, locale, scenario } = options;
  const system = studentSystemPrompt(persona, locale, scenario);
  /** phaseごとの発話回数。`silent` の「初回だけ答える」を決定的にするための数え。 */
  const spoken: Record<StudentPhase, number> = { lesson: 0, teach_back: 0 };

  return {
    persona,
    async answer(turnsSoFar, phase) {
      // **無言は決定的に作る。**毎回黙らせると授業の全パスが答え待ちの
      // タイムアウトで終わり、板書の続きも教え返しも一度も測れない
      // (それは「無言の生徒」ではなく「何も起きなかった試行」)。
      // phaseの最初の1回は答えて、以降は黙る。
      if (persona === "silent" && spoken[phase] > 0) return null;

      const recap = renderLessonRecap(turnsSoFar.slice(-studentContextTurns), locale);
      const raw = await llm.complete({
        system,
        user: STUDENT_INSTRUCTION[locale](recap, phase),
        maxTokens: studentMaxTokens,
      });

      const said = asSpokenLine(raw);
      if (said !== null) spoken[phase] += 1;
      return said;
    },
  };
}

export type ScriptedStudent = EvalStudent & {
  /** 呼ばれた順の記録。**問いかけの手順で呼ばれたか**をテストが見る。 */
  readonly asked: { phase: StudentPhase; turns: readonly LessonTurn[] }[];
};

/**
 * 台本どおりに答える生徒。**テストと、駆動そのものを確かめるときに使う。**
 *
 * 台本を使い切ったら以降は `null`(無言)。足りないぶんを最後の答えで
 * 埋め続けると、往復の上限まで同じ答えを繰り返す授業を測ることになる。
 */
export function createScriptedStudent(answers: readonly (string | null)[]): ScriptedStudent {
  const asked: { phase: StudentPhase; turns: readonly LessonTurn[] }[] = [];
  let call = 0;

  return {
    persona: "scripted",
    asked,
    answer(turnsSoFar, phase) {
      asked.push({ phase, turns: [...turnsSoFar] });
      const said = answers[call] ?? null;
      call += 1;
      return Promise.resolve(said);
    },
  };
}
