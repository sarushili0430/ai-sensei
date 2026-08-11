import type { BoardStep } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { boardLessonSystemPrompt, conversationSystemPrompt } from "@ai-sensei/prompts";
import { type SessionContext, subjectOf } from "./context.ts";

/**
 * 板書授業とフェーズ2「教え返し」をつなぐ、agent 側にしか置けないもの。
 *
 * **人格と約束はここには無い。**正本は `prompts/senpai_conversation.{ja,en}.md` で、
 * このファイルが持つのは3つだけ:
 *
 *   1. **定型の一言**(教え返しへの受け渡し・立て直し)。
 *      会話LLMを通さずにTTSへ直接渡す文なので、プロンプトには置けない。
 *   2. **板書の要約**(`lesson_recap` に入れる値)。板書は配送層の事実
 *      (`BoardStep`)なので、プロンプト側からは見えない。
 *   3. **セッション文脈から各プロンプトへ写す値**。写真と復習の穴を
 *      同じ欄に偽装せず、`lesson_mode` で選べる形にする。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【板書の内容は instructions にだけ入れる。transcript には入れない】
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 先輩が何を教えたかを知らないと、教え返しを聞いても「言えた / 詰まった」の
 * 判定ができない。だが計画書 §2 の設計制約は
 * **「出題元はユーザーが説明した内容。AIが教えた内容から作らない」**で、
 * カルテと小テストの材料は transcript だけ。
 *
 * だから板書の要約は **instructions(この層)にだけ**渡し、
 * 授業中の発話は `addToChatCtx: false` で transcript に入れない(`agent.ts`)。
 * 「先輩は知っているが、カルテの材料にはならない」という置き分けになる。
 * この線引きは `senpai_conversation.<locale>.md` の本文にも二重に書いてある。
 */

/** 授業が終わったら教え返しへ渡す。計画書 §2 のコアループの2つ目。 */
const TEACH_BACK_PROMPT: Record<CurriculumLocale, string> = {
  ja: "じゃあ今の、自分の言葉で説明してみて。",
  en: "Alright — now explain that back to me in your own words.",
};

/**
 * 板書が1行も出せなかったときの立て直し。
 *
 * **黙って会話に落とさない。**板書ゼロで「じゃあ今の、説明してみて」と言うと、
 * 教わっていないことの説明を求めることになる。何が起きたかを認めて、
 * 生徒の手が止まっている場所を聞くところからやり直す。
 */
const LESSON_FAILED_PROMPT: Record<CurriculumLocale, string> = {
  ja: "ごめん、板書がうまく出せなかった。口でやろっか。この問題、どこまでできた?",
  en: "Sorry — the board didn't come up. Let's just talk it through. How far did you get?",
};

/**
 * 復習セッションの最初の一言。板書は出さず、前回の穴から聞き直す。
 *
 * 通常の復習は `review_hole` から板書を始める。これは新しいagentを先に出した
 * デプロイの窓で、古いAPIが欄を送らなかったときだけ使う互換フォールバック。
 *
 * **「覚えてる?」と聞かない。**それは `senpai_conversation.*.md` が禁じている
 * 申告させる聞き方そのもので、「うん」で返せてしまう。言わせて判定する。
 */
const REVIEW_OPENING: Record<CurriculumLocale, string> = {
  ja: "この前つまずいたとこ、もう一回説明してみて。",
  en: "Let's take another run at the bit you got stuck on — explain it to me.",
};

/** 復習には「この問題」が存在しないので、板書失敗時も穴を起点に立て直す。 */
const REVIEW_LESSON_FAILED_PROMPT: Record<CurriculumLocale, string> = {
  ja: "ごめん、板書がうまく出せなかった。口でやろっか。前に止まったところ、何が引っかかる?",
  en: "Sorry — the board didn't come up. Let's talk it through. What catches you at that spot?",
};

/**
 * 板書がまだ1行も無いときに `lesson_recap` へ入れる定型句。
 *
 * **会話の言語で書く。**日本語の「(なし)」が英語のプロンプトに混ざると、
 * モデルはそこだけ日本語で応答しはじめる(`render.ts` の `phrases` と同じ理由)。
 * 空文字を渡さないのは、見出しだけが残った節を先輩が読むと
 * 「板書はあるが読めない」と解釈しうるから。**無いことを書く。**
 */
const NO_LESSON_RECAP: Record<CurriculumLocale, string> = {
  ja: "(まだ板書には何も出していません)",
  en: "(nothing on the board yet)",
};

/**
 * 最後の手順が、もう生徒に番を渡しているか。
 *
 * 渡しているのに {@link teachBackPrompt} を続けると、先輩が同じことを2回言う。
 * 板書プロンプト(`senpai_board.*.md`)は「教えたら必ず『じゃあ今の、自分の言葉で
 * 説明してみて』に渡す」と指示しているので、**普通に成功した授業では毎回起きる**。
 *
 * **文言の一致ではなく「番を渡したか」で見る。**切り分けの質問
 * (「最初の一手、言ってみて」)で終わった授業も、答えを待っている状態なので同じ扱い。
 */
const HANDOFF_PATTERNS: Record<CurriculumLocale, RegExp[]> = {
  ja: [/説明してみて/, /言ってみて/, /やってみて/, /話してみて/, /書いてみて/],
  en: [/explain\b/i, /your own words/i, /tell me\b/i, /give it a (?:go|shot|try)/i, /try it\b/i],
};

export function teachBackPrompt(locale: CurriculumLocale): string {
  return TEACH_BACK_PROMPT[locale];
}

export function lessonFailedPrompt(
  locale: CurriculumLocale,
  kind: SessionContext["kind"] = "new",
): string {
  return kind === "review" ? REVIEW_LESSON_FAILED_PROMPT[locale] : LESSON_FAILED_PROMPT[locale];
}

export function reviewOpening(locale: CurriculumLocale): string {
  return REVIEW_OPENING[locale];
}

export function handsTurnToStudent(speech: string, locale: CurriculumLocale): boolean {
  const normalized = speech.trim();
  if (normalized.length === 0) return false;
  return HANDOFF_PATTERNS[locale].some((pattern) => pattern.test(normalized));
}

/**
 * セッション開始時に板書授業へ入るか。
 *
 * `review` はすでに小テストで「まだ」→「先輩に聞く」を選んだあとに作られる。
 * ここでもう一度説明だけを求めると、§2 の「詰まったら授業モードへ」を1段戻し、
 * 生徒は**教えてもらうために同じ詰まりを二度見せる**ことになる。したがって
 * 通常の2種類はどちらも板書から始める。ただし、新しいagentを先に出した
 * ローリングデプロイの窓では、古いAPIが `review_hole` を送らない。その復習だけは
 * 根拠なしで板書を作らず、従来の聞き直し会話へ縮退する。
 */
export function startsWithBoardLesson(
  context: Pick<SessionContext, "kind" | "review_hole">,
): boolean {
  return context.kind === "new" || context.review_hole != null;
}

/**
 * 復習の穴を板書プロンプトへ貼るJSON。
 *
 * `problem_text` へ穴を詰めない。問題写真の事実と前回の観測を混ぜると、
 * 「問題写真なしなら推測しない」という新規授業の保険が効かなくなる。
 * JSONにするのは `desc` / `evidence` の改行や引用符まで**データの境界内**に置き、
 * 見出しに化けさせないため。新規授業では文字列 `null` を渡し、ロケール固有の
 * ダミー文言を増やさない。
 */
export function renderReviewBoardContext(context: SessionContext): string {
  return context.review_hole == null ? "null" : JSON.stringify(context.review_hole, null, 2);
}

export type SenpaiBoardLessonInput = {
  context: SessionContext;
  remainingSeconds: number;
};

/**
 * 写真起点と穴起点を、同じ板書プロンプトの明示的なモードへ写す。
 *
 * 別の復習プロンプトをコピーしない理由は `packages/prompts/src/index.ts` に置いた。
 * ここでは**どちらの入力も渡し、本文に mode で片方だけ選ばせる**。復習時にも
 * `problem_text` を契約どおりのプレースホルダのまま渡すことで、写真が無い事実を
 * 穴の説明で上書きしない。
 */
export function senpaiBoardLessonPrompt(input: SenpaiBoardLessonInput): string {
  const { context } = input;
  return boardLessonSystemPrompt(
    {
      lesson_mode: context.kind,
      problem_text: context.problem_text,
      student_work: context.visible_work,
      review_context: renderReviewBoardContext(context),
      allowed_topics: context.allowed_topics,
      remaining_seconds: input.remainingSeconds,
    },
    { locale: context.locale, subject: subjectOf(context) },
  );
}

/**
 * 板書LLMが最後の一言で番を渡し忘れたときの、コード側の保険。
 *
 * プロンプトだけに任せると、生成が1回ぶれただけで「教えて終わり」になる。
 * 一方、すでに番を渡しているのに毎回定型句を足すと同じ質問を二度聞く。
 * 実際に配送できた最後の手順を見て、不足したときだけ教え返しへ戻す。
 */
export function teachBackFallback(
  context: Pick<SessionContext, "locale">,
  steps: readonly BoardStep[],
): string | null {
  const last = steps.at(-1);
  if (last === undefined || handsTurnToStudent(last.speech, context.locale)) return null;
  return teachBackPrompt(context.locale);
}

/**
 * 板書の要約の上限(文字)。
 *
 * 板書1枚は最大40手順(`boardStepsMaxCount`)で、`speech` 120字 + `tex` 200字が
 * 上限だから、詰まると10KB級になる。instructions は毎ターン全部送られるので、
 * そのまま入れると会話のたびに板書ぶんの入力トークンを払い続けることになる。
 *
 * 溢れたときは**先頭から入れて、入らなくなったところで止める**(末尾を落とす)。
 * 授業は上から積み上がる構造なので、途中で切れても「ここまでは教えた」が読める。
 * 逆に先頭を落とすと、話の前提だけが消えた飛び飛びの板書が残る。
 */
export const lessonRecapMaxLength = 2000;

/** 板書1要素を1行で書き下す。先輩に「何を書いたか」を思い出させるためだけの表現。 */
function describeBoard(board: BoardStep["board"], locale: CurriculumLocale): string | null {
  if (board === null) return null;
  const label = locale === "en" ? "board" : "板書";
  switch (board.kind) {
    case "latex":
      return `${label}: ${board.tex}`;
    case "text":
      return `${label}: ${board.body}`;
    case "plot":
      return `${label}: y = ${board.fn} (${board.domain.min} .. ${board.domain.max})`;
    case "triangle":
      return `${label}: ${locale === "en" ? "triangle" : "三角形"}${
        board.labels === undefined ? "" : ` ${board.labels.join("")}`
      }`;
    case "circle":
      return `${label}: ${locale === "en" ? "circle" : "円"} r = ${board.r}`;
    // 英語の板書。**例文と、そこで見せた焦点まで**を残す。
    // 「例文を出した」だけだと、教え返しで何を聞き返せばいいか決められない。
    case "sentence":
      return [
        `${label}: ${board.text}`,
        board.gloss === undefined ? null : `(${board.gloss})`,
        board.focus === undefined ? null : `[${board.focus}]`,
      ]
        .filter((part) => part !== null)
        .join(" ");
    case "compare":
      return `${label}: ${board.title ?? board.columns.join(" / ")} — ${board.rows
        .map((row) => row.join(" / "))
        .join(" | ")}`;
    default:
      return null;
  }
}

/**
 * 送った板書を、先輩が読み返せる形に畳む。
 * 1行も無ければ**空文字ではなく「無い」と書いた定型句**を返す(上の `NO_LESSON_RECAP`)。
 */
export function renderLessonRecap(
  steps: readonly BoardStep[],
  locale: CurriculumLocale,
  maxLength: number = lessonRecapMaxLength,
): string {
  const lines: string[] = [];
  let length = 0;

  // 引用符も本文と同じ言語のものを使う。英語のプロンプトに「」が混ざると、
  // そこだけ日本語で応答しはじめる(`render.ts` の `phrases` と同じ理由)。
  const [open, close] = locale === "en" ? ['"', '"'] : ["「", "」"];

  for (const step of steps) {
    const board = describeBoard(step.board, locale);
    const line = `${step.index + 1}. ${open}${step.speech}${close}${
      board === null ? "" : ` / ${board}`
    }`;
    if (length + line.length > maxLength) break;
    lines.push(line);
    length += line.length + 1;
  }

  return lines.length === 0 ? NO_LESSON_RECAP[locale] : lines.join("\n");
}

export type SenpaiConversationInput = {
  context: SessionContext;
  /** 会話の残り時間。締めに入る判断に使う(会話プロンプトの変数)。 */
  remainingSeconds: number;
  /** 授業で実際にワイヤーへ出した手順。授業前だけ空でよい。 */
  lesson?: readonly BoardStep[];
};

/**
 * 教え返しを聞く先輩のシステムプロンプト。
 *
 * `SessionContext` と板書の手順を、プロンプトの変数に写すだけの層。
 * **人格・約束・聞き方は `prompts/senpai_conversation.<locale>.md` にある。**
 * ここに文言を足したくなったら、それはプロンプト側に書くべきもの。
 */
export function senpaiConversationPrompt(input: SenpaiConversationInput): string {
  const locale = input.context.locale;
  return conversationSystemPrompt(
    {
      photo_summary: input.context.photo_summary,
      visible_work: input.context.visible_work,
      allowed_topics: input.context.allowed_topics,
      question_seeds: input.context.question_seeds,
      lesson_recap: renderLessonRecap(input.lesson ?? [], locale),
      remaining_seconds: input.remainingSeconds,
    },
    { locale, subject: subjectOf(input.context) },
  );
}
