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
 * 授業の1コマ。板書に積んだ手順と、その合間の生徒の発話を、起きた順に並べたもの。
 *
 * 授業は1回のLLM呼び出しでは終わらない(`board.ts` の寿命の説明)。問いかけで止まり、
 * 生徒の答えを聞いて、同じ板書に続きを積む。その往復を教え返しのプロンプトと
 * 継続指示の両方が読めるよう、手順と発話を1本の列で持つ。
 */
export type LessonTurn = { kind: "step"; step: BoardStep } | { kind: "student"; text: string };

/** 授業の列から、実際に配送された手順だけを抜く。 */
export function lessonSteps(turns: readonly LessonTurn[]): BoardStep[] {
  return turns
    .filter((turn): turn is Extract<LessonTurn, { kind: "step" }> => turn.kind === "step")
    .map((turn) => turn.step);
}

/**
 * 答えを待ったが、生徒が何も言わなかったときの記録。
 *
 * 生徒の発話ではないので transcript(カルテの材料)には入れない。授業の列にだけ
 * 残して、続きを書くLLMに「答えは無かった — 軽く自分で言って先へ進む」を選ばせる。
 */
const STUDENT_SILENCE: Record<CurriculumLocale, string> = {
  ja: "(返事はなかった)",
  en: "(no reply)",
};

export function studentSilenceMarker(locale: CurriculumLocale): string {
  return STUDENT_SILENCE[locale];
}

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

/**
 * 疑問符。**「〜してみて」型だけを番の受け渡しと見なしていたのが、実際の壊れ方だった。**
 *
 * 問題の写真が読めなかった授業は、板書プロンプトの指示どおり
 * 「問題、読んでもらってもいい?」から始まる。これは上のどのパターンにも当たらないので
 * `teachBackFallback` が**無条件で**「じゃあ今の、自分の言葉で説明してみて。」を続けていた
 * (2026-08-12 の報告そのもの)。生徒から見ると、読み上げを頼まれた次の瞬間に
 * **まだ何も教わっていない内容の説明を求められる**。
 *
 * 先輩が問いかけで終えたなら、形がどうであれ**番はもう生徒にある**。
 *
 * **全角の `？` はコードポイントで書く(`？`)。**
 * 一度ここを `[??]` と生の字で書いて、`？` が半角に潰れたまま入っていた
 * (見た目は2文字だが中身は `?` が2つで、全角では止まらない)。
 * 日本語の出力はほとんど全角なので、**この取りこぼしは日本語の授業ぜんぶに効く** —
 * 直したはずのターン制が、そのまま元に戻る。字で書けば次も同じ形で壊れるので、
 * 目で見て違いの分かる書き方にしておく。
 */
const QUESTION_MARK = /[?？]\s*$/;

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
  if (QUESTION_MARK.test(normalized)) return true;
  return HANDOFF_PATTERNS[locale].some((pattern) => pattern.test(normalized));
}

/**
 * 「じゃあ今の、自分の言葉で説明してみて」の形か。**授業の往復を終える唯一の合図。**
 *
 * {@link handsTurnToStudent} は「番を渡したか」を見る広い判定で、切り分けの質問も
 * 途中の問いかけ(「最小公倍数、何になると思う?」)も true になる。そこで往復を
 * 終えると、質問を1つしただけで板書の続きが書けなくなる — まさに
 * 「先輩がすぐ説明を投げてくる」というドッグフーディングの報告の形。
 *
 * だから途中の問いかけは**答えを聞いて同じ板書に続け**、教え返しへ渡す言い方
 * (板書プロンプトが最後の手順に固定している文言の族)だけで授業を終える。
 * 文言を変えるときはプロンプト(`senpai_board.*.md` の受け渡しの節)と一緒に変えること
 * (`prompts/README.md` の二重書きの表)。
 */
const TEACH_BACK_HANDOFF_PATTERNS: Record<CurriculumLocale, RegExp[]> = {
  ja: [/自分の言葉で説明/, /説明してみて/],
  en: [/your own words/i, /explain (?:that|it|this) back/i],
};

export function asksForTeachBack(speech: string, locale: CurriculumLocale): boolean {
  const normalized = speech.trim();
  if (normalized.length === 0) return false;
  return TEACH_BACK_HANDOFF_PATTERNS[locale].some((pattern) => pattern.test(normalized));
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
 * 板書に1行でも書いたか。**音声だけの手順は「教えた」に数えない。**
 *
 * `board: null` の手順は、切り分けの質問と相づちのための枠
 * (`senpai_board.*.md` の要素表)。それしか出ていない授業は、
 * 生徒の画面では**見出しだけの白い黒板**で、教わった中身はどこにも残っていない。
 */
export function wroteOnBoard(steps: readonly BoardStep[]): boolean {
  return steps.some((step) => step.board !== null);
}

/**
 * 板書LLMが最後の一言で番を渡し忘れたときの、コード側の保険。
 *
 * プロンプトだけに任せると、生成が1回ぶれただけで「教えて終わり」になる。
 * 一方、すでに番を渡しているのに毎回定型句を足すと同じ質問を二度聞く。
 * 実際に配送できた最後の手順を見て、不足したときだけ教え返しへ戻す。
 *
 * **板書に1行も書いていない回では足さない。**「じゃあ今の」の「今の」が
 * 存在しないので、教わっていないことの説明を求めることになる(§2 の逆)。
 * 実際に起きていたのは次の並びで、しかも会話プロンプトは
 * 「いまやっていること — 教え返し」で固定なので、**そのまま堂々巡りになる**:
 *
 *   先輩「問題、読んでもらってもいい?」  ← 写真から問題文が取れなかった授業の第一声
 *   先輩「じゃあ今の、自分の言葉で説明してみて。」  ← ここ(無条件で足していた)
 *
 * 立て直しは呼び出し側の責務(`agent.ts` が `lessonFailedPrompt` を出す)。
 * ここは「**足さない**」だけを決める。
 */
export function teachBackFallback(
  context: Pick<SessionContext, "locale">,
  steps: readonly BoardStep[],
): string | null {
  const last = steps.at(-1);
  if (last === undefined || handsTurnToStudent(last.speech, context.locale)) return null;
  if (!wroteOnBoard(steps)) return null;
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
    case "figure":
      // **名前のついた点を出す。**ここを「図」の一言で畳むと、先輩は自分が置いた点を
      // 思い出せず、次の説明で同じ図を描き直す(D-12「図が育たない」の原因はこれだった)。
      // `alt` は agent が詰めるので、まだ無い場合(検証前)は点の名前だけで書く。
      return `${label}: ${board.alt ?? (locale === "en" ? "figure" : "図")}${(() => {
        const names = board.items
          .map((item) => item.pt)
          .filter((name): name is string => typeof name === "string");
        return names.length === 0 ? "" : ` [${names.join(" ")}]`;
      })()}`;
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
 * 授業の列を1行ずつ書き下す。手順は `index + 1` の番号、発話はロール名で始める。
 *
 * `keep` は溢れたときにどちらを残すか。教え返しの要約は**先頭**を残す
 * (授業は上から積み上がる構造なので、途中で切れても「ここまでは教えた」が読める)。
 * 続きを書かせる指示は**末尾**を残す — 直前の問いかけと生徒の答えが読めないと、
 * 続きがその答えと噛み合わない。
 */
function renderTurnLines(
  turns: readonly LessonTurn[],
  locale: CurriculumLocale,
  studentLabel: string,
  maxLength: number,
  keep: "head" | "tail",
): string[] {
  // 引用符も本文と同じ言語のものを使う。英語のプロンプトに「」が混ざると、
  // そこだけ日本語で応答しはじめる(`render.ts` の `phrases` と同じ理由)。
  const [open, close] = locale === "en" ? ['"', '"'] : ["「", "」"];

  const all = turns.map((turn) => {
    if (turn.kind === "student") return `${studentLabel}: ${open}${turn.text}${close}`;
    const board = describeBoard(turn.step.board, locale);
    return `${turn.step.index + 1}. ${open}${turn.step.speech}${close}${
      board === null ? "" : ` / ${board}`
    }`;
  });

  const lines: string[] = [];
  let length = 0;
  for (const line of keep === "head" ? all : [...all].reverse()) {
    if (length + line.length > maxLength) break;
    if (keep === "head") lines.push(line);
    else lines.unshift(line);
    length += line.length + 1;
  }
  return lines;
}

/**
 * 送った板書と合間の発話を、先輩が読み返せる形に畳む。
 * 1行も無ければ**空文字ではなく「無い」と書いた定型句**を返す(上の `NO_LESSON_RECAP`)。
 *
 * ロール名は transcript の整形(`formatTranscript`)と同じ語彙にそろえる。
 * 生徒の行が入るのは、往復した授業の答え(「12だと思う」)を会話側が知らないと、
 * **同じ質問をもう一度聞く**ところから教え返しが始まってしまうため。
 */
export function renderLessonRecap(
  turns: readonly LessonTurn[],
  locale: CurriculumLocale,
  maxLength: number = lessonRecapMaxLength,
): string {
  const label = locale === "en" ? "Student" : "ユーザー";
  const lines = renderTurnLines(turns, locale, label, maxLength, "head");
  return lines.length === 0 ? NO_LESSON_RECAP[locale] : lines.join("\n");
}

/**
 * 続きの往復の上限(文字)。教え返しの要約より広く取る。
 *
 * こちらは**会話のたび**ではなく授業の往復1回につき1度しか送らないので、
 * 入力トークンの重みが違う。それでも上限は要る — 板書1枚は最大40手順で、
 * 上限の `speech` と `tex` で詰まると10KB級になる(`lessonRecapMaxLength` と同じ計算)。
 */
export const lessonContinuationRecapMaxLength = 4000;

/**
 * 2回目以降の授業パスに渡すユーザーメッセージ。
 *
 * systemプロンプト(問題・規約・人物像)は毎回同じ正本を使い、**何が起きたかだけ**を
 * ここで渡す。生徒の答えをsystemに織り込む作りにすると、パスのたびにプロンプトの
 * 正本と実行時の合成物がずれていく(どの文が正本か分からなくなる)。
 *
 * 「答えが合っていたら板書に書いて先へ・詰まっていたらそこを教える」という
 * **応え方**はここに書かない。それは教え方で、正本(`senpai_board.*.md` の
 * 「授業は往復する」)の責務。ここは形式(同じ板書に続く・indexは0から・
 * 繰り返さない)だけを縛る。
 */
const CONTINUATION_INSTRUCTION: Record<CurriculumLocale, (recap: string) => string> = {
  ja: (recap) =>
    [
      "ここまでの授業のやりとりです。番号つきの行はあなたが板書に積んだ手順、「生徒:」の行はそのときの生徒の発話です。",
      "",
      recap,
      "",
      "この続きから、同じ授業のJSON(`title` / `topic_ids` / `steps`)だけを返してください。",
      "- `title` と `topic_ids` は前回と同じものを書きます(板書は開き直されず、手順は同じ板書の下に積まれます)。",
      "- `steps` の `index` はまた 0 から数えます。",
      "- すでに板書に出した手順を繰り返さない・書き直さないこと。続きだけを書きます。",
      "- 最初の手順の `speech` は、直前の生徒の言葉への短い応えから始めてください。",
    ].join("\n"),
  en: (recap) =>
    [
      'This is the lesson so far. Numbered lines are the steps you have already put on the board; "Student:" lines are what the student said in between.',
      "",
      recap,
      "",
      "Continue from here. Return only the lesson JSON (`title` / `topic_ids` / `steps`).",
      "- Write the same `title` and `topic_ids` as before (the board is not reopened; new steps stack under the same board).",
      "- Number `steps` from `index` 0 again.",
      "- Never repeat or rewrite steps that are already on the board — write only what comes next.",
      "- Start the first step's `speech` with a short response to what the student just said.",
    ].join("\n"),
};

export function lessonContinuationInstruction(
  turns: readonly LessonTurn[],
  locale: CurriculumLocale,
): string {
  const label = locale === "en" ? "Student" : "生徒";
  const lines = renderTurnLines(turns, locale, label, lessonContinuationRecapMaxLength, "tail");
  return CONTINUATION_INSTRUCTION[locale](lines.join("\n"));
}

export type SenpaiConversationInput = {
  context: SessionContext;
  /** 会話の残り時間。締めに入る判断に使う(会話プロンプトの変数)。 */
  remainingSeconds: number;
  /** 授業で実際に起きたこと(配送済みの手順と合間の発話)。授業前だけ空でよい。 */
  lesson?: readonly LessonTurn[];
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
