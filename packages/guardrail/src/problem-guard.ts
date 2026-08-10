import type { CurriculumLocale } from "@ai-sensei/curriculum";

/**
 * 問題文の妥当性(グラウンディングのガード)。
 *
 * 解析器が書き起こした `problem_text` は、そのまま先輩の板書LLMに渡り、
 * **その授業で教える内容の起点**になる。ここに解答が混ざると、先輩は
 * 解き方を組み立てずに答えを写す — **板書が「答え合わせの表示器」に劣化する。**
 *
 * 改正後の約束1で「答えを教える」ことは許されているが(デッキ §0)、
 * **板書の価値は解き方の筋道**であって答えではない(§3-1 の「数式・計算・図は板書」の
 * 中身は解法)。問題集の紙面には章末の解答や赤字の解説が併記されていることがあり、
 * ページ全体が写ると、そこまで問題文として流れ込む。
 *
 * ## 方針: **完全な判定は目指さない。迷ったら通す。**
 *
 * この判定は**過検出のほうが害が大きい**。正当な問題文を落とすと `problem_text` は
 * 空になり、先輩は「(問題の写真なし)」から始める — つまり**問題が写っているのに
 * 見ないまま教える**、いちばん避けたかった状態に自分で戻すことになる。
 * 一方、解答が少し混ざったまま通っても、先輩は問題文として読むだけで、
 * 教え返しフェーズ(§1-1)の保険は生きている。
 *
 * だから、ここに置くのは**それが出てきたら問題文ではありえない印**だけにする:
 *
 *   - 解答の**見出し**(`【解答】` `[Solution]` `解説:`)。囲みかコロンを必須にして、
 *     「解答用紙に記入せよ」「答えを四捨五入せよ」のような**設問中の語**を巻き込まない
 *   - `∴`(ゆえに)。設問には出ず、解答の途中にしか出ない記号
 *   - 散文が1語も無い断片(`x^2 - 3x + 2 = 0` だけ)。何を問われているか書かれていない
 *
 * **入っていない判定と、その理由**:
 *   - 「よって」「したがって」 … 設問側にも出うる(「よって得られる値を答えよ」)
 *   - 裸の `Answer:` … 問題集の**解答欄の見出し**として空欄の上に印刷されている。
 *     生徒が解く前の紙面にも載っているので、解答が混ざった証拠にならない
 *   - 数値が並んでいる(`(1) 2個 (2) k=±√10`)… 設問の選択肢と区別がつかない
 *
 * 長さの上限は `@ai-sensei/contract` の `problemTextMaxLength` と `backend/api` の
 * 責務なので、ここでは見ない(`latex-guard.ts` が文字数を見ないのと同じ分担)。
 */

/**
 * 解答の見出し。**囲みかコロンを必ず伴う形だけ**を拾う。
 *
 * 裸の「解答」「答」を拾うと、設問そのものに含まれる
 * 「解答用紙」「解答欄」「答えを求めよ」「答えは小数第2位まで」を巻き込む。
 * 見出しは紙面上で必ず区切られているので、この形で十分に取れる。
 */
const solutionHeadings: readonly RegExp[] = [
  // 【解答】 [解説] (解) ［略解］ — 囲み記号つきの見出し
  /[【[［(（〔]\s*(?:解答|解説|略解|解|答)\s*[】\]］)）〕]/u,
  // 行頭・文末の直後に「解答:」「解説:」。設問の途中には現れない位置。
  /(?:^|[\n。])\s*(?:解答|解説|略解)\s*[:：]/u,
  // [Solution] / (Answer) — 囲みつき。裸の `Answer:` は解答欄の見出しなので入れない。
  /[[［(（]\s*(?:solution|answer|ans\.?)\s*[\]］)）]/iu,
  // 行頭の "Solution:"。`answer` は入れない(上と同じ理由)。
  /(?:^|[\n.])\s*solutions?\s*[:：]/iu,
  // ゆえに。設問には出ず、解答の途中にしか出ない。
  /∴|\\therefore\b/u,
];

/**
 * 散文が1語でもあるか。**「何を問われているか」が書かれている印**として使う。
 *
 *   - 日本語: **かな**があること。設問は必ず「〜を求めよ」「次の〜」の形になるので、
 *     かなが1文字も無い書き起こしは、式か見出しの断片
 *   - 英語: **3文字以上の英単語**があること。`Solve` `Find` `Prove` はすべて満たす。
 *     2文字以下に落とすと変数名(`x` `ab`)が散文に見えてしまう
 *
 * `sin` `cos` `log` は3文字なので通る。**それでよい** — この関数は
 * 「設問かどうか」ではなく「**明らかに設問でない断片**か」だけを見ている(迷ったら通す)。
 */
const kanaPattern = /[ぁ-んァ-ヶー]/u;
const proseWordPattern = /[A-Za-z]{3,}/u;

export const problemRejectionReasons = [
  /** 解答・解説が問題文に混ざっている。 */
  "solution_included",
  /** 設問が見当たらない(式だけの断片)。 */
  "not_a_problem",
] as const;
export type ProblemRejectionReason = (typeof problemRejectionReasons)[number];

export type ProblemVerdict =
  | { ok: true }
  | { ok: false; reason: ProblemRejectionReason; detail: string };

/**
 * 書き起こされた問題文を検査する。
 *
 * **ロケールを取らない。** 解答の見出しは日本語と英語で文字種が重ならない
 * (「解答」と `Solution:`)ので、両方を同時に当てても取り違えが起きない。
 * 引数を1つ減らし、「間違ったロケールを渡して素通りする」経路自体を無くしてある。
 */
export function checkProblemText(text: string): ProblemVerdict {
  const trimmed = text.trim();

  const heading = solutionHeadings.find((pattern) => pattern.test(trimmed));
  if (heading !== undefined) {
    return {
      ok: false,
      reason: "solution_included",
      detail: "問題文に解答・解説が混ざっています",
    };
  }

  if (!kanaPattern.test(trimmed) && !proseWordPattern.test(trimmed)) {
    return {
      ok: false,
      reason: "not_a_problem",
      detail: "設問が書かれていません(式だけの断片です)",
    };
  }

  return { ok: true };
}

/**
 * 再生成プロンプトに添える指示。**会話の言語で書く**
 * (`latex-guard.ts` と同じ理由)。
 *
 * 宛先は**写真解析のプロンプト**(`prompts/photo_analysis.*.md`)であって、
 * 板書LLMではない。直すのは「紙面のどこを書き写すか」なので、
 * 指示も「取る範囲」を名指しする形にしてある。
 *
 * **いまはどこからも使われていない。** `backend/api` の `resolveSessionProblem()` は
 * 再解析せずに `problem` を `null` に畳む — 解答が混ざる原因は紙面の写し方なので、
 * 同じ写真を投げ直しても同じものが返るため。再生成の経路を足すときのために、
 * 理由と対で置いてある。**足すかどうかは、ログの `solution_included` の頻度を見て決めること**
 * (頻繁に出るなら、直すべきは再解析ではなく解析プロンプトの側)。
 */
export const problemRejectionGuidanceByLocale: Record<
  CurriculumLocale,
  Record<ProblemRejectionReason, string>
> = {
  ja: {
    solution_included:
      "problem_text には設問だけを書き写すこと。同じ紙面に章末の答え・赤字の解説・別冊解答が写っていても、そこは取らないこと。",
    not_a_problem:
      "problem_text に設問(「〜を求めよ」「〜を解け」など)まで含めて書き写すこと。式だけでは何を問われているか分かりません。設問が写っていなければ空文字にすること。",
  },
  en: {
    solution_included:
      "Copy only the question into problem_text. Even if the answer key, the worked solution, or the back-of-book answers are in the same photo, leave them out.",
    not_a_problem:
      'Include the actual instruction ("solve", "find", "prove") in problem_text, not just the expression. Without it there is no way to tell what is being asked. If no question is visible, use an empty string.',
  },
};

/** 既定(ロケール未指定)では日本語の説明。 */
export const problemRejectionGuidance: Record<ProblemRejectionReason, string> =
  problemRejectionGuidanceByLocale.ja;
