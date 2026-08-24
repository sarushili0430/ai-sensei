import { type BoardStep, problemTextMaxLength } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { checkProblemText, normalizeMathSpeech } from "@ai-sensei/guardrail";
import {
  boardLessonSystemPrompt,
  conversationSystemPrompt,
  formatProblemText,
} from "@ai-sensei/prompts";
import { type SessionContext, subjectOf } from "./context.ts";

/**
 * 板書授業と、板書が使えないときの会話をつなぐ、agent 側にしか置けないもの。
 *
 * **人格と約束はここには無い。**正本は `prompts/senpai_conversation.{ja,en}.md` で、
 * このファイルが持つのは3つだけ:
 *
 *   1. **定型の一言**(時間切れの締め・板書失敗の立て直し・復習の入り)。
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
 * 先輩が何を教えたかを知らないと、生徒の説明を聞いても「言えた / 詰まった」の
 * 判定ができない。だが計画書 §2 の設計制約は
 * **「出題元はユーザーが説明した内容。AIが教えた内容から作らない」**で、
 * カルテと小テストの材料は transcript だけ。
 *
 * だから板書の要約は **instructions(この層)にだけ**渡し、
 * 授業中の発話は `addToChatCtx: false` で transcript に入れない(`agent.ts`)。
 * 「先輩は知っているが、カルテの材料にはならない」という置き分けになる。
 * この線引きは `senpai_conversation.<locale>.md` の本文にも二重に書いてある。
 */

/**
 * 残り時間が尽きたときの、先輩の締めの一言。
 *
 * **この一言だけが、時間切れを事故に見せないための手当て。**回数の上限を外した
 * (ADR 0009)結果、天井は「残り時間」だけになった。`waitForEnd` の `timeout` は
 * 会話の途中で切るので、これを言わずに降りると生徒には**説明の途中で
 * 先輩が消えた**ようにしか見えない。
 *
 * `closing.ts` の締め検出と**同じ文言**にしてある。あちらは会話LLMの締めを拾う口で、
 * こちらはコードが直接TTSへ渡す文だが、生徒に届く言葉は1つにしておく。
 *
 * **責めない。**「時間切れです」とも「もっと早く言ってくれれば」とも言わない。
 */
const TIME_UP_CLOSING: Record<CurriculumLocale, string> = {
  ja: "今日はここまでにしよっか。また来たとき、この続きやろう。",
  en: "Let's stop here for today. Next time you're here, let's pick this up.",
};

/**
 * 授業の1コマ。板書に積んだ手順と、その合間の生徒の発話を、起きた順に並べたもの。
 *
 * 授業は1回のLLM呼び出しでは終わらない(`board.ts` の寿命の説明)。問いかけで止まり、
 * 生徒の答えを聞いて、同じ板書に続きを積む。その往復を会話のプロンプトと
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
 * 答えを待っているのか、言い切ったのかで**次のパスの書き出しが変わる**
 * (待っているなら答えを聞いてから続ける)。
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
 * 「問題、読んでもらってもいい?」から始まる。これは上のどのパターンにも当たらないので、
 * かつての `teachBackFallback` が**無条件で**「じゃあ今の、自分の言葉で説明してみて。」を
 * 続けていた(2026-08-12 の報告そのもの)。生徒から見ると、読み上げを頼まれた次の瞬間に
 * **まだ何も教わっていない内容の説明を求められる**。あの保険は ADR 0009 で消えたが、
 * **「問いかけで終えた回を、言い切りと読み違える」誤りはここに残っている** —
 * いまは誤読すると、答えを待たずに続きを書き足す形で出る。
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

export function timeUpClosing(locale: CurriculumLocale): string {
  return TIME_UP_CLOSING[locale];
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
 * この手順で先輩が**生徒の答えを待つ**か。番の受け渡しの判定は全部ここを通す。
 *
 * 一次情報は手順の `awaits_student`(**LLM自身の申告**。contract の
 * `boardStepSchema` を参照)。{@link handsTurnToStudent} は**欄が無い手順の
 * フォールバック**に格下げした。理由は実際の壊れ方そのもの:
 *
 *   末尾 `?` と言い回しの列挙では、板書プロンプトの見本どおりの
 *   「まず何する? **一言でいいよ。**」すら取りこぼす(`?` が文中に沈む)。
 *   取りこぼした瞬間、授業ループは「番を渡さず言い切った」= 渡し忘れと誤読して
 *   **1パス目で授業を終え、教え返しへ落としていた**。以降のセッションは音声だけになり、
 *   板書は最初の数行のまま二度と増えない —
 *   「板書がイニシャルのステートで止まっている」報告の正体
 *   (教え返しは ADR 0009 で畳んだので、いまの誤読は1パスぶんの空回りで止まる)。
 *
 * 逆向きの誤りも同じ欄で直る: 修辞疑問(「まず(1)からやろっか?」)は末尾が `?` でも
 * `awaits_student: false` と申告されるので、1手順目で止まらない(#105 の症状A)。
 *
 * 申告が誤っていたときの倒れ方は従来と同じ側に寄せる — 欄の値を優先する。
 * 渡し忘れた回はもう授業を終わらせない(`lesson-loop.ts` が続きを書かせる)ので、
 * 誤読の代償は「答えを待たずに先へ進む」1パスぶんで止まる。
 */
export function stepAwaitsStudent(
  step: Pick<BoardStep, "speech" | "awaits_student">,
  locale: CurriculumLocale,
): boolean {
  return step.awaits_student ?? handsTurnToStudent(step.speech, locale);
}

/** 類題を解き終わるまで待つ手順か。通常の会話待ちとはタイムアウトが違う。 */
export function stepAwaitsSolving(step: Pick<BoardStep, "awaits_solving">): boolean {
  return step.awaits_solving === true;
}

/** 配送を止めて生徒へ番を渡す手順か。 */
export function stepAwaitsInput(
  step: Pick<BoardStep, "speech" | "awaits_student" | "awaits_solving">,
  locale: CurriculumLocale,
): boolean {
  return stepAwaitsSolving(step) || stepAwaitsStudent(step, locale);
}

export type SolvingReport = "solved" | "stuck" | "unclear";

/**
 * 類題への本人申告を読む。**正誤判定ではない。**
 *
 * ボタンの定型文も声の自然な言い換えも同じ `lk.chat` / STT 入力へ来るため、
 * この1本で分岐する。否定形は「できた」を内包するので必ず先に見る。
 *
 * **「でき**て**ない」の `て` を忘れない。** 声で答える生徒は言い切りより
 * 「まだできてない」と言うほうが多く、これを落とすと `unclear` に沈んで
 * 「できた? 止まった?」と聞き直す — はっきり詰まりを伝えた生徒に、
 * もう一度同じことを言わせることになる。
 */
const SOLVING_REPORT_PATTERNS: Record<CurriculumLocale, { stuck: RegExp; solved: RegExp }> = {
  ja: {
    stuck:
      /(?:でき|解け)(?:て(?:ない|ません)|ない|なかった|ません|ませんでした)|分からない|わからない|わかんない|詰まった|無理|だめ|ダメ/,
    solved: /できた|できました|解けた|解けました|終わった|終わりました/,
  },
  en: {
    stuck:
      /\b(?:could(?:n't| not)|can(?:'t|not)|did(?:n't| not) (?:get|solve)|don(?:'t| not) know|stuck|could not do it)\b/i,
    solved: /\b(?:done|finished|solved(?: it)?|got it|i did it|i could do it)\b/i,
  },
};

export function classifySolvingReport(text: string, locale: CurriculumLocale): SolvingReport {
  const normalized = text.normalize("NFKC").trim();
  if (SOLVING_REPORT_PATTERNS[locale].stuck.test(normalized)) return "stuck";
  if (SOLVING_REPORT_PATTERNS[locale].solved.test(normalized)) return "solved";
  return "unclear";
}

/**
 * 生徒に問題文の音読を頼む言い回し。
 *
 * **完全な意図分類ではなく、観測と状態遷移のための狭い族**にする。
 * 「問題」という語だけで拾うと、ふつうの切り分け質問まで音読扱いになり、直後の
 * 答えで `problem_text` を上書きしてしまう。問題/設問と、読む・言う・教えるの
 * 両方があるときだけ拾う。
 * 8〜30字の幅は助詞や丁寧表現を挟める一方、別の文まで結びつけない長さ。
 * 英語命令形の末尾15字は `out loud` / `to me` を収めるためにだけ空ける。
 *
 * **「教えて」だけは間を3字に詰める。** 読む・言うと違って「教えて」は
 * 音読以外の依頼にも付くので、8字空けると「この問題、**何を聞かれてるか**教えて」
 * 「この問題、**どこまでやったか**教えて」— 問題文が無いときこそ出る切り分けの質問 —
 * まで音読依頼になり、その答えが問題文として居座る。読む・言う側は
 * 「問題、**ちょっと**読んでもらっていい?」を拾うために8字のまま残す。
 */
const PROBLEM_READOUT_PATTERNS: Record<CurriculumLocale, readonly RegExp[]> = {
  ja: [
    /問題(?:文)?(?:を|[、,\s])*.{0,8}(?:読んで(?:もら|くれ|みて|ください|ほしい)|読み上げて(?:もら|くれ|みて|ください|ほしい)|言って(?:もら|くれ|みて|ください|ほしい))/u,
    /問題(?:文)?(?:を|[、,\s])*.{0,3}教えて/u,
    /問題(?:文)?(?:を|[、,\s])*.{0,8}(?:読んで|読み上げて)[?？!！。]?\s*$/u,
  ],
  en: [
    /\b(?:can|could|would|will)\s+you\b.{0,30}\b(?:read|say)\b.{0,30}\b(?:question|problem)\b/iu,
    /\bplease\b.{0,20}\b(?:read|say)\b.{0,30}\b(?:question|problem)\b/iu,
    /^\s*(?:read|say)\b.{0,30}\b(?:question|problem)\b.{0,15}[.?!]?\s*$/iu,
    /\btell me\b.{0,30}\b(?:question|problem)\b/iu,
    /\bwhat does (?:the )?(?:question|problem) say\b/iu,
  ],
};

export function asksForProblemReadout(speech: string, locale: CurriculumLocale): boolean {
  const normalized = speech.trim();
  if (normalized.length === 0) return false;
  return PROBLEM_READOUT_PATTERNS[locale].some((pattern) => pattern.test(normalized));
}

/** metadata の定型句が、まだ問題文を受け取っていない唯一の印。 */
export function problemTextIsMissing(
  context: Pick<SessionContext, "locale" | "problem_text">,
): boolean {
  return context.problem_text === formatProblemText(null, context.locale);
}

/**
 * 音読を頼まれて**断った / 答えられなかった**返事。
 *
 * 頭に「えっと」「うーん」が付く形まで見るのは、声の返事がほぼその形で来るため。
 * 逆に文中に「わからない」が出てくるだけの文
 * (「この問題、x がわからないときの解き方を求めよ」)は問題文でありうるので、
 * **先頭に限る**。
 */
const REFUSAL_PATTERNS: Record<CurriculumLocale, RegExp> = {
  ja: /^(?:えー?っと|うーん|あの|ごめん)?[、,\s]*(?:わかん?ない|わかりません|分から?ない|読めない|見えない|無理|ちょっと待って|まだ(?:読|見)?[^。]*ない)/u,
  en: /^(?:um+|uh+|well|sorry)?[,\s]*(?:i\s+(?:can'?t|cannot|don'?t|do not|dunno)|no idea|not sure|hold on|wait)\b/iu,
};

export type SpokenProblemMemoryResult =
  | { accepted: true; length: number }
  | {
      accepted: false;
      reason:
        | "not_new"
        | "already_present"
        | "empty"
        | "too_long"
        | "solution_included"
        | "not_a_problem";
    };

/**
 * 音読を頼んだ直後の発話を、**この agent のメモリ上だけ**で問題文として覚える。
 *
 * 発話の字面だけで「これは音読」と判定しない。呼び出すのは授業ループが
 * `asksForProblemReadout` かつ `awaits_student: true` の直後だと確定した場合だけ。
 * ここは採用条件と差し替えだけを持つ。
 *
 * **APIへは書き戻さない。** 今回は同じオブジェクトを差し替えることで、次パス、
 * 復習問題の生成まで同じ問題文を使う。永続化は #130/#150 の統一文脈で、
 * この関数の採用結果を `PATCH /problem` へつなげればよい。
 */
export function rememberSpokenProblemText(
  context: SessionContext,
  spoken: string,
): SpokenProblemMemoryResult {
  if (context.kind !== "new") return { accepted: false, reason: "not_new" };
  if (!problemTextIsMissing(context)) return { accepted: false, reason: "already_present" };

  // transcript と同じ正規化を先に通す。音読した「エックス二乗」をそのまま
  // system prompt に貼るより、板書LLMが式として読める形へ揃えるほうが安全。
  const text = normalizeMathSpeech(spoken, context.locale).text.trim();
  if (text.length === 0) return { accepted: false, reason: "empty" };
  if (text.length > problemTextMaxLength) return { accepted: false, reason: "too_long" };

  /**
   * **音読を頼まれて断った返事は、問題文ではない。**
   *
   * 「わかりません」「読めない」は `checkProblemText` を素通りする(解答マーカーも
   * 式だけの断片も無いので)。そのまま採用すると、それが以降のパスとカルテの
   * `problem_text` になり、**問題文が無い状態のほうがまだましな形**で嘘の文脈が居座る。
   * 読めなかったのなら、定型句のままにしておくのが正しい。
   */
  if (REFUSAL_PATTERNS[context.locale].test(text)) {
    return { accepted: false, reason: "not_a_problem" };
  }

  // 本人が入力した問題文と同じ側で見る。答えまで読み上げた発話を採用すると、
  // 写真と手入力で塞いだ解答混入の穴が音声経路から開く。
  const verdict = checkProblemText(text, "manual");
  if (!verdict.ok) return { accepted: false, reason: verdict.reason };

  // SessionContext は entry からカルテ生成まで同じ参照を運ぶ。ここで欄だけを
  // 差し替えれば、パスごとに組み直す system() と終了時のカルテが両方追随する。
  context.problem_text = text;
  return { accepted: true, length: text.length };
}

/**
 * 授業の外で、生徒が**板書に書くこと**を求めているか。
 *
 * 授業ループを抜けたあとの会話LLMは板書に書く手段を持たない。以前はそこで
 * 「板書して」と頼まれると、**書けない事実を取り繕う返事**(「最初にしたから、
 * ここからは言葉だけでいくね」)が返っていた — 板書は開いたまま残っていて、
 * 続きを積む配管(`BoardDelivery.append`)も生きているのに、である。
 *
 * この判定に引っかかった発話は会話LLMに渡さず、授業ループへ**再入**して
 * 同じ板書の続きで応える(`agent.ts` の `serveBoardRequests`)。
 *
 * **語彙は狭く保つ。**「書いて」だけで拾うと、生徒の説明そのもの
 * (「ここで式を書いて解く」)が誤って授業へ吸い込まれる。板書・黒板と
 * 名指しされたときだけ拾う(取りこぼした言い回しは従来どおり会話が受ける)。
 */
const BOARD_REQUEST_PATTERNS: Record<CurriculumLocale, RegExp> = {
  ja: /板書|黒板/,
  en: /\b(?:black|white)?board\b/i,
};

export function asksForBoard(text: string, locale: CurriculumLocale): boolean {
  return BOARD_REQUEST_PATTERNS[locale].test(text);
}

// ここには `asksForTeachBack`(「じゃあ今の、自分の言葉で説明してみて」の検出)があった。
//
// **ADR 0009 で消した。**あれは「先輩の言い方で授業を終える」ための判定で、
// 教え返しへ渡す合図だった。降ろすのが生徒の「わかった」だけになった以上、
// 先輩の言い回しで授業が終わる道は**残っていてはいけない** — 残すと、
// 生成が1回ぶれて「説明してみて」と言った瞬間に、押していない生徒の授業が終わる。

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
  context: Pick<SessionContext, "kind" | "review_hole" | "review_problem">,
): boolean {
  return context.kind === "new" || context.review_problem != null || context.review_hole != null;
}

/**
 * 復習の根拠を板書プロンプトへ貼るJSON。
 *
 * **復習問題があればそちらを渡す**(ADR 0009)。「この問いに、こう答えて、
 * こう判定された」は、穴の「説明が止まった」より具体的で、先輩が何を教え直せば
 * いいかが決まる。移行前に溜まった穴から入った復習だけが `review_hole` を使う。
 *
 * `problem_text` へ詰めない。問題写真の事実と前回の観測を混ぜると、
 * 「問題写真なしなら推測しない」という新規授業の保険が効かなくなる。
 * JSONにするのは改行や引用符まで**データの境界内**に置き、見出しに化けさせないため。
 * 新規授業では文字列 `null` を渡し、ロケール固有のダミー文言を増やさない。
 */
export function renderReviewBoardContext(context: SessionContext): string {
  if (context.review_problem != null) {
    return JSON.stringify(context.review_problem, null, 2);
  }
  return context.review_hole == null ? "null" : JSON.stringify(context.review_hole, null, 2);
}

export type SenpaiBoardLessonInput = {
  context: SessionContext;
};

/**
 * 写真起点と穴起点を、同じ板書プロンプトの明示的なモードへ写す。
 *
 * 別の復習プロンプトをコピーしない理由は `packages/prompts/src/index.ts` に置いた。
 * ここでは**どちらの入力も渡し、本文に mode で片方だけ選ばせる**。復習時にも
 * `problem_text` を契約どおりのプレースホルダのまま渡すことで、写真が無い事実を
 * 穴の説明で上書きしない。
 *
 * **残り時間はここに含めない**({@link senpaiBoardRemainingNote})。ここが返すものは
 * 問題が変わるまで1バイトも動かない — それがプロンプトキャッシュの前提になる。
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
    },
    { locale: context.locale, subject: subjectOf(context) },
  );
}

/**
 * 残り時間だけを載せる、systemの**最後の1行**。
 *
 * 本文(`senpai_board.*.md` の「締め方」)が「残り時間はいちばん最後に書いてある」と
 * 言っている、その最後がここ。**キャッシュの印より後ろに置く**ので、パスごとに
 * 変わってもプレフィックスは壊れない(`lesson.ts` の `systemTail`)。
 *
 * 短く保つこと。ここはキャッシュに載らない = 毎パス丸ごと課金される側で、
 * 長い規約を足すとキャッシュの意味がその分だけ薄まる。
 */
export function senpaiBoardRemainingNote(
  remainingSeconds: number,
  locale: CurriculumLocale,
): string {
  // 負の残り時間は出さない。「-30秒」を読ませても締め方は決まらないし、
  // 上限時間の打ち切りは `lesson-loop.ts` の安全弁が別に持っている。
  const seconds = Math.max(0, Math.floor(remainingSeconds));
  return locale === "en"
    ? `You have ${seconds} seconds left in this lesson.`
    : `この授業の残り時間は ${seconds} 秒です。`;
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

// ここには `teachBackFallback` があった。**ADR 0009 で消した。**
//
// 「板書LLMが最後の一言で番を渡し忘れたら、定型句で教え返しへ戻す」保険で、
// 戻す先(教え返し)が無くなった時点で役目が終わっている。渡し忘れた回は
// 授業ループが続きを書かせる(`lesson-loop.ts` の `lesson_no_handoff_continued`)。

/**
 * 板書の要約の上限(文字)。
 *
 * 板書1枚は最大40手順(`boardStepsMaxCount`)で、`speech` 120字 + `tex` 200字が
 * 上限だから、詰まると10KB級になる。instructions は毎ターン全部送られるので、
 * そのまま入れると会話のたびに板書ぶんの入力トークンを払い続けることになる。
 *
 * 溢れたときは原則として**先頭から入れて、入らなくなったところで止める**。
 * 授業は上から積み上がる構造なので、途中で切れても「ここまでは教えた」が読める。
 * 逆に先頭を落とすと、話の前提だけが消えた飛び飛びの板書が残る。
 *
 * ただし最後の類題と、そのあと板書した正答は末尾でも必ず残す。ここが落ちると、
 * 会話LLMは説明対象と正答を知らないまま「どうしてそうなるか」を聞くことになる。
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
    // 「例文を出した」だけだと、あとで何を聞き返せばいいか決められない。
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
 * `keep` は溢れたときにどちらを残すか。会話へ渡す要約は**先頭**を残す
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

  /**
   * **番号は `step.index` ではなく、板書に積まれた通し位置で振る。**
   *
   * 継続の指示は「`index` はまた 0 から数えます」なので、2パス目以降の手順は
   * 1・2・3 を取り直す。それをそのまま書くと、要約の中に同じ番号が何度も並び、
   * **問いかけで名指しする「2行目」がどの行なのか決まらなくなる** —
   * 生徒に違う行を見せる誘導になる。板書は開き直さずに積み上がるので、
   * ここで数え上げた位置がそのまま画面上の行にあたる。
   */
  let boardLine = 0;
  const all = turns.map((turn) => {
    if (turn.kind === "student") return `${studentLabel}: ${open}${turn.text}${close}`;
    boardLine += 1;
    const board = describeBoard(turn.step.board, locale);
    return `${boardLine}. ${open}${turn.step.speech}${close}${board === null ? "" : ` / ${board}`}`;
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

/** {@link renderTurnLines} と同じ表現で、1行だけ書き下す。 */
function renderTurnLine(turn: LessonTurn, locale: CurriculumLocale, studentLabel: string): string {
  const [open, close] = locale === "en" ? ['"', '"'] : ["「", "」"];
  if (turn.kind === "student") return `${studentLabel}: ${open}${turn.text}${close}`;
  const board = describeBoard(turn.step.board, locale);
  const boardSuffix = board === null ? "" : ` / ${board}`;
  return `${turn.step.index + 1}. ${open}${turn.step.speech}${close}${boardSuffix}`;
}

/**
 * 送った板書と合間の発話を、先輩が読み返せる形に畳む。
 * 1行も無ければ**空文字ではなく「無い」と書いた定型句**を返す(上の `NO_LESSON_RECAP`)。
 *
 * ロール名は transcript の整形(`formatTranscript`)と同じ語彙にそろえる。
 * 生徒の行が入るのは、往復した授業の答え(「12だと思う」)を会話側が知らないと、
 * **同じ質問をもう一度聞く**ところから会話が始まってしまうため。
 */
export function renderLessonRecap(
  turns: readonly LessonTurn[],
  locale: CurriculumLocale,
  maxLength: number = lessonRecapMaxLength,
): string {
  const label = locale === "en" ? "Student" : "ユーザー";
  const all = turns.map((turn) => renderTurnLine(turn, locale, label));

  // 最後に出した類題と、そのあと最初に板書した行(正答)を予約する。
  // 失敗→教え直し→再挑戦があっても、説明対象になる最後の1問だけを残せばよい。
  let solvingIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.kind === "step" && stepAwaitsSolving(turn.step)) {
      solvingIndex = index;
      break;
    }
  }
  const answerIndex =
    solvingIndex < 0
      ? -1
      : turns.findIndex(
          (turn, index) => index > solvingIndex && turn.kind === "step" && turn.step.board !== null,
        );
  const reservedIndexes = new Set([solvingIndex, answerIndex].filter((index) => index >= 0));
  const reserved = [...reservedIndexes]
    .sort((left, right) => left - right)
    .map((index) => all[index] as string);
  const reservedLength = reserved.reduce((length, line) => length + line.length + 1, 0);

  const head: string[] = [];
  let length = reservedLength;
  for (const [index, line] of all.entries()) {
    if (reservedIndexes.has(index)) continue;
    if (length + line.length > maxLength) break;
    head.push(line);
    length += line.length + 1;
  }
  const lines = [...head, ...reserved];
  return lines.length === 0 ? NO_LESSON_RECAP[locale] : lines.join("\n");
}

/**
 * 続きの往復の上限(文字)。会話へ渡す要約より広く取る。
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
const CONTINUATION_INSTRUCTION: Record<
  CurriculumLocale,
  (
    recap: string,
    lastIsStudent: boolean,
    problemReadoutAlreadyRequested: boolean,
    solvingReport?: SolvingReport,
  ) => string
> = {
  ja: (recap, lastIsStudent, problemReadoutAlreadyRequested, solvingReport) =>
    [
      "ここまでの授業のやりとりです。番号つきの行はあなたが板書に積んだ手順、「生徒:」の行はそのときの生徒の発話です。",
      "",
      recap,
      "",
      "この続きから、同じ授業のJSON(`title` / `topic_ids` / `steps`)だけを返してください。",
      "- `title` と `topic_ids` は前回と同じものを書きます(板書は開き直されず、手順は同じ板書の下に積まれます)。",
      "- `steps` の `index` はまた 0 から数えます。",
      "- すでに板書に出した手順を繰り返さない・書き直さないこと。続きだけを書きます。",
      // 条件付きの行は**要素ごと落とす**。空文字を混ぜて join すると、
      // 頼んでいない回(ほとんどの回)の箇条書きが空行で分断される。
      ...(problemReadoutAlreadyRequested
        ? ["- 問題文の読み上げはもう一度頼みません。直前の生徒の発話を受けて続けてください。"]
        : []),
      // 続きを頼む理由は2つある。答えを受けての続きと、途中で切れた説明の続き。
      // 生徒が何も言っていないのに「直前の生徒の言葉に応えろ」と書くと、
      // 言われていない言葉への返事を作り始める。
      lastIsStudent
        ? "- 最初の手順の `speech` は、直前の生徒の言葉への短い応えから始めてください。"
        : "- 説明は途中で切れています。最後の手順のすぐ続きから教えてください。",
      ...(solvingReport === "solved"
        ? [
            "- 直前の「できた」は本人申告です。採点済み・正解したとは言わないでください。",
            "- 類題の正答を `board` に1行で書き、そのあと「じゃあ、どうしてそうなるか、自分の言葉で説明してみて。」と聞いてください。",
            "- 最後の手順は `awaits_student: true` とし、`awaits_solving` は付けません。",
          ]
        : solvingReport === "stuck"
          ? [
              "- 直前の「できなかった」は責めずに受け止め、まず「どこで止まった?」とだけ聞いてください。",
              "- その手順は `awaits_student: true` とし、答えを聞く前に解説や別の類題を続けません。",
            ]
          : solvingReport === "unclear"
            ? [
                "- 直前の言葉から完了か詰まりかを推測せず、できたか・止まったかだけを短く確認してください。",
                "- その手順は `awaits_student: true` とします。",
              ]
            : []),
    ].join("\n"),
  en: (recap, lastIsStudent, problemReadoutAlreadyRequested, solvingReport) =>
    [
      'This is the lesson so far. Numbered lines are the steps you have already put on the board; "Student:" lines are what the student said in between.',
      "",
      recap,
      "",
      "Continue from here. Return only the lesson JSON (`title` / `topic_ids` / `steps`).",
      "- Write the same `title` and `topic_ids` as before (the board is not reopened; new steps stack under the same board).",
      "- Number `steps` from `index` 0 again.",
      "- Never repeat or rewrite steps that are already on the board — write only what comes next.",
      ...(problemReadoutAlreadyRequested
        ? [
            "- Do not ask the student to read the question again. Continue from what they just said.",
          ]
        : []),
      lastIsStudent
        ? "- Start the first step's `speech` with a short response to what the student just said."
        : "- The explanation broke off. Pick it up right after the last step.",
      ...(solvingReport === "solved"
        ? [
            "- Treat the completion report only as the student's self-report; never say it was graded or correct.",
            '- Put the analogous problem\'s correct answer in one `board` line, then ask exactly: "Now explain in your own words why it works out that way."',
            "- Set `awaits_student: true` on that final step and do not set `awaits_solving`.",
          ]
        : solvingReport === "stuck"
          ? [
              '- Respond without blame and first ask only: "Where did you get stuck?"',
              "- Set `awaits_student: true` on that step; do not explain ahead or pose a different problem before hearing the answer.",
            ]
          : solvingReport === "unclear"
            ? [
                "- Do not infer whether they succeeded. Briefly ask whether they finished or got stuck.",
                "- Set `awaits_student: true` on that step.",
              ]
            : []),
    ].join("\n"),
};

export function lessonContinuationInstruction(
  turns: readonly LessonTurn[],
  locale: CurriculumLocale,
  solvingReport?: SolvingReport,
): string {
  const label = locale === "en" ? "Student" : "生徒";
  const lines = renderTurnLines(turns, locale, label, lessonContinuationRecapMaxLength, "tail");
  const problemReadoutAlreadyRequested = turns.some(
    (turn) => turn.kind === "step" && asksForProblemReadout(turn.step.speech, locale),
  );
  return CONTINUATION_INSTRUCTION[locale](
    lines.join("\n"),
    turns.at(-1)?.kind === "student",
    problemReadoutAlreadyRequested,
    solvingReport,
  );
}

export type SenpaiConversationInput = {
  context: SessionContext;
  /** 会話の残り時間。締めに入る判断に使う(会話プロンプトの変数)。 */
  remainingSeconds: number;
  /** 授業で実際に起きたこと(配送済みの手順と合間の発話)。授業前だけ空でよい。 */
  lesson?: readonly LessonTurn[];
};

/**
 * 板書が使えないときに口だけで続ける先輩のシステムプロンプト(縮退専用)。
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
