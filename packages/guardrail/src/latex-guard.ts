import type { CurriculumLocale } from "@ai-sensei/curriculum";

/**
 * 板書LaTeXのコマンド照合(三段構えの②)。
 *
 * `flutter_math_fork` はKaTeXのDart移植で、本家が通すコマンドを全部は描けない。
 * **描けないコマンドが端末に届くと、板書がその行だけ空白か例外になる。**
 * 授業の途中で1行消えるのは、遅いより悪い。だから送る前に機械的に照合する。
 *
 * 三段の分担(`docs/pivot_plan_v1.md` §3-6):
 *
 *   | 層 | どこ | 何を防ぐ |
 *   | --- | --- | --- |
 *   | ① 式テンプレート | プロンプト | 許可コマンドの誤った**組み合わせ方** |
 *   | ② コマンドの照合 | **ここ** | 移植版が**対応していない**コマンド |
 *   | ③ KaTeXでの実パース | backend/agent | **構文の壊れ**(括弧の閉じ忘れ・引数の過不足) |
 *
 * **ここでやらないこと**:
 *   - 文字数の上限と、多行環境(`align` など)の禁止は `@ai-sensei/contract` の
 *     `board.ts` が既に弾いている。二重に実装しない。
 *   - 構文が通るかは見ない(③の担当)。このモジュールは
 *     `packages/guardrail` の約束どおり **副作用なし・外部依存なし** で書く。
 *     KaTeXを持ち込まないのはそのため。
 *
 * 落ちたものは agent 側で**再生成させる**(プロンプトの制約と機械検査の二重ガード)。
 */

/**
 * 許可するコマンド。**2026-08-09 のスパイクで、実際にPNG化して目視したものだけ**。
 * 一覧の正は `docs/pivot_plan_v1.md` §3-6。
 *
 * **規約: 実測でPNGを見て確認したものだけを足すこと。**
 * 「KaTeXのドキュメントに載っているから」で足してはいけない。移植版が対応しているとは
 * 限らないというのが、この層が存在する理由そのもの。ここが緩むとガードの意味が消える。
 *
 * 未検証で**まだ入れていない**もの(W1後半〜W2で実測してから足す):
 *   3×3以上の行列・3行以上の `cases`。
 *
 * 実測して**弾くと決めた**もの(未検証ではない):
 *   `\text` 系({@link textCommands})・`\overparen`(弧の記号。2026-08-12 の実測で
 *   `flutter_math_fork` が描けず `数式を表示できません` に化けた。弧は `text` に「弧AB」と書く)。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【2026-08-12 追加】幾何の記号が1つも無く、図形の授業が板書ごと落ちていた
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 「接弦定理を使う外接円の証明」の授業で、板書が見出しだけで1行も出なかった。
 * 原因はここ — **∠ も △ も ∽ も ° も無かった。**
 * `\angle CAD = \angle ABC` は `unknown_command` で落ち、作り直しも同じ族に落ちる。
 * 落ちた手順は `board.ts` がその回の説明ごと打ち切るので、**1つの記号で授業が終わる。**
 *
 * 図形は高校数学の主要分野で、そこで書きたい式がひとつも通らないのは
 * 「描けないコマンドを止める」ではなく「単元ごと止める」になっていた。
 * 下の追加分は **2026-08-12 に `flutter_math_fork` で実際に描画してPNGを目視**し、
 * 記号が出ていることを確認したものだけ(`\overparen` はその場で落ちたので入れていない)。
 */
export const allowedLatexCommands: ReadonlySet<string> = new Set([
  // 演算・関係
  "\\cdot",
  "\\leq",
  "\\geq",
  "\\neq",
  "\\pm",
  "\\times",
  "\\div",
  "\\mp",
  "\\approx",
  // `\leq` の別綴り。**モデルは短いほうを日常的に書く。**
  // 描けるものを綴りだけで落とすと、直しの往復が丸ごと無駄になる。
  "\\le",
  "\\ge",
  "\\ne",
  "\\lt",
  "\\gt",
  // 図形。**ここが空だったせいで、図形の単元が板書ごと落ちていた**(上の経緯)。
  "\\angle",
  "\\triangle",
  "\\perp",
  "\\parallel",
  // 相似(∼)と合同。日本の教科書は ∽ と ≡、英語圏は ∼ と ≅ を使うので両方入れる
  // (記法の使い分けは①=プロンプトの責務。`\binom` と同じ分担)。
  "\\sim",
  "\\cong",
  "\\equiv",
  // 度(`90^\circ`)。図形の授業では角度の単位として毎回出る。
  "\\circ",
  // 論証の矢印。板書の「⇒」を text 要素に追い出すと、式と結論が別の行に割れる。
  "\\Rightarrow",
  "\\Leftrightarrow",
  // 集合(数学A「集合と論理」)
  "\\in",
  "\\notin",
  "\\subset",
  "\\supset",
  "\\cap",
  "\\cup",
  "\\emptyset",
  "\\varnothing",
  "\\infty",
  // 省略。数列・級数で `a_1 + a_2 + \cdots + a_n` の形になる
  "\\cdots",
  "\\ldots",
  "\\dots",
  // 上線。線分・共役複素数・平均(`\bar{x}`)
  "\\overline",
  "\\bar",
  // 分数・根号(`\sqrt[3]{}` の任意引数を含む)
  "\\frac",
  "\\cfrac",
  "\\sqrt",
  // 関数
  "\\sin",
  "\\cos",
  "\\tan",
  "\\log",
  // 自然対数。**日本の教科書は `\log_{e}`** だが、それは①(プロンプト)で決める記法の話で、
  // ここは「描けるか」だけを見る層(`\binom` と同じ分担)。2026-08-12 に描画を確認した。
  "\\ln",
  // 総和・極限・積分
  "\\sum",
  "\\lim",
  "\\to",
  "\\int",
  // 定積分の計算途中 `\Bigl[ x^3 + x^2 \Bigr]_0^1` に使う可変サイズ括弧。
  // 計画書 §3-6b が「実際に画面から溢れる式」として名指ししている形なので、必ず出てくる。
  "\\Bigl",
  "\\Bigr",
  // 自動サイズの括弧。2026-08-12 の実測で `\left( \frac{a}{b} \right)` が正しく伸びた。
  // **モデルがいちばん自然に書く形**で、`\Bigl` へ書き換えさせる往復には
  // 板書の停止(1手順ぶんの沈黙)を払う価値が無い。対応の壊れは③(KaTeXの実パース)が見る。
  "\\left",
  "\\right",
  // 余白。`\quad` は式を横に並べるとき(連立方程式など)に使う
  "\\quad",
  // 二項係数。**海外課程の標準記法**なので入れる。
  // 日本の課程では教科書記法 `{}_{n}\mathrm{C}_{r}` を使わせるが、それは
  // 「どちらの教科書に合わせるか」の話であって「描けるか」の話ではない。
  // 記法の使い分けは①(プロンプト)の責務で、②のここで弾くと
  // **英語の授業だけ表現が落ちる**(`\ln` を保留していることの裏返しでもある)。
  "\\binom",
  // ベクトル
  "\\vec",
  "\\overrightarrow",
  // 書体。教科書記法の {}_n\mathrm{P}_r / {}_n\mathrm{C}_r に必須
  "\\mathrm",
  // ギリシャ文字
  "\\theta",
  "\\alpha",
  "\\beta",
  "\\pi",
  // 論証の接続。実効幅340pt での再実測(2026-08-09)で ∴ / ∵ の描画を確認済み。
  // 日本の板書で多用するので、記号のまま出せることに意味がある。
  "\\therefore",
  "\\because",
]);

/**
 * 英字以外の1文字コマンド。`\\[a-zA-Z]+` だけでトークンを取ると**取りこぼす**種類で、
 * 許可リストを作るときも同じ理由で見落としやすい。
 *
 * - `\,` 細スペース(総和・積分の前後)
 * - `\ ` エスケープした空白(`\sin\theta,\ \cos\theta` のような列挙の区切り)
 * - `\{` `\}` 集合の波括弧
 *
 * 行区切りの `\\` はここに**入れない**。文脈で可否が変わるので個別に判定する
 * ({@link checkBoardLatex} の `\\` と `&` の扱いを参照)。
 */
export const allowedLatexSymbolCommands: ReadonlySet<string> = new Set([
  "\\,",
  "\\ ",
  "\\{",
  "\\}",
]);

/**
 * 許可する環境。行列と場合分けだけ。
 * `align` などの多行環境は contract 側(`board.ts` の `tex`)が先に弾くので、
 * ここに来る時点では残っていないはずだが、**単独で使っても正しく落ちる**ようにしてある
 * (guardrailは contract を依存に持たない層なので、向こうの検査を前提にしない)。
 */
export const allowedLatexEnvironments: ReadonlySet<string> = new Set(["pmatrix", "cases"]);

/**
 * 数式の中に文章を置くコマンド。**許可リストに無い**ので放っておいても
 * `unknown_command` で落ちるが、**専用の理由を立てて別扱いにする**。
 *
 * 理由:
 *   1. **LLMが最もやりたがる書き方**だから。「よって」「ゆえに」「なぜなら」を
 *      板書に出そうとすれば `\text{}` を使うのが自然な発想で、頻繁に来る。
 *   2. これは禁止ではなく **「置き場所が違う」** だから。日本語の一行は
 *      contract の `{ kind: "text", body }` に置く場所が既にある。
 *      再生成の指示が「使うな」で終わっていると、LLMは `\mathrm{よって}` のような
 *      別の書き方に逃げて堂々巡りになる。**行き先を教える**ために理由を分ける。
 *
 * 実測(2026-08-09):`\text{よって}\ x=2` の「よって」が **4本の黒い棒(tofu)** になった。
 * KaTeXのフォント(`KaTeX_Main`)が日本語グリフを持たないため。
 * これは widget test 環境での結果で、実機ではシステムフォントに落ちて描ける可能性が
 * 理屈上はある。**それでも禁止のままにする** — 実機で直るかは未検証であり、
 * かつ直ったとしても `text` 要素がある以上、数式ブロックに日本語を入れる理由がないため。
 */
const textCommands: ReadonlySet<string> = new Set([
  "\\text",
  "\\textrm",
  "\\textbf",
  "\\textit",
  "\\textsf",
  "\\texttt",
  "\\mbox",
]);

/**
 * かな・漢字・全角記号。**コマンドを介さなくても同じ壊れ方をする**ので、
 * `tex` 全体を見る。`\mathrm{よって}` も裸の `よって` も、化けるのは同じ理由
 * (フォントにグリフが無い)。コマンド名の列挙だけでは塞ぎきれない。
 */
const japaneseCharacters = /[　-〿぀-ヿ一-鿿＀-ﾟ]/;

export const latexRejectionReasons = [
  /** 移植版が対応しているか未確認のコマンド。 */
  "unknown_command",
  /** 数式の中に文章・日本語を入れている(置き場所は contract の `text` 要素)。 */
  "text_in_math",
  /** 許可していない環境(`align` など)。 */
  "unknown_environment",
  /** `\begin` と `\end` が対応していない。 */
  "unbalanced_environment",
  /** 環境の外で `\\`(改行)や `&`(列区切り)を使っている。 */
  "row_separator_outside_environment",
] as const;
export type LatexRejectionReason = (typeof latexRejectionReasons)[number];

export type LatexVerdict =
  | { ok: true }
  | { ok: false; reason: LatexRejectionReason; detail: string };

/**
 * トークンの抽出。
 *
 * 4種類を1本で拾う:
 *   1. `\begin{pmatrix}` / `\end{cases}` — 環境の出入り
 *   2. `\frac` のような英字コマンド
 *   3. `\,` `\{` `\\` のような英字以外の1文字コマンド(`\\[a-zA-Z]+` では拾えない)
 *   4. `&` — 列区切り。コマンドではないが、環境の外にあってはいけない
 *
 * 波括弧・数字・英字そのもの(変数)は見ない。**ここはコマンドの照合だけ**を担う。
 */
const LATEX_TOKEN = /\\(begin|end)\{([^}]*)\}|\\([a-zA-Z]+)|\\([^a-zA-Z])|(&)/g;

/**
 * 板書に載せる数式1つを検査する。
 *
 * **`\\`(改行)と `&`(列区切り)は、環境の内側でだけ許す。**
 * 無条件に許すと `pmatrix` / `cases` が全部落ちるので許可は必須だが、
 * 環境の外に置かれた `\\` は「1行の板書」を2行に割る指示になり、
 * §3-1 の「1手順=1行」と、それを前提にした画面の積み上げが崩れる。
 * contract 側は**多行環境**を禁止しているが、裸の `\\` は素通りするので、
 * その穴はここで閉じる(責務が重ならない、いちばん近い層がここ)。
 *
 * 環境の対応が壊れている場合も落とす。内側かどうかを追えなくなり、
 * `\\` の可否を判断する前提そのものが失われるため
 * (構文の壊れを網羅的に見るのは③の担当で、これはその代わりではない)。
 */
export function checkBoardLatex(tex: string): LatexVerdict {
  // コマンドより先に見る。`\mathrm{よって}` のように、許可コマンドの引数に
  // 入れられると、トークンの照合だけでは素通りしてしまう。
  const japanese = tex.match(japaneseCharacters);
  if (japanese !== null) {
    return {
      ok: false,
      reason: "text_in_math",
      detail: `数式の中の日本語は表示できません(文字化けします): ${japanese[0]}`,
    };
  }

  const openEnvironments: string[] = [];

  for (const match of tex.matchAll(LATEX_TOKEN)) {
    const [, beginOrEnd, environment, command, symbol, ampersand] = match;

    if (beginOrEnd !== undefined && environment !== undefined) {
      if (!allowedLatexEnvironments.has(environment)) {
        return {
          ok: false,
          reason: "unknown_environment",
          detail: `描画を確認していない環境: ${environment}`,
        };
      }
      if (beginOrEnd === "begin") {
        openEnvironments.push(environment);
        continue;
      }
      if (openEnvironments.pop() !== environment) {
        return {
          ok: false,
          reason: "unbalanced_environment",
          detail: `\\end{${environment}} に対応する \\begin がありません`,
        };
      }
      continue;
    }

    if (command !== undefined) {
      if (textCommands.has(`\\${command}`)) {
        return {
          ok: false,
          reason: "text_in_math",
          detail: `数式の中に文章を置くコマンド: \\${command}`,
        };
      }
      if (!allowedLatexCommands.has(`\\${command}`)) {
        return {
          ok: false,
          reason: "unknown_command",
          detail: `描画を確認していないコマンド: \\${command}`,
        };
      }
      continue;
    }

    // `\\`(行区切り)と `&`(列区切り)。環境の内側でだけ意味を持つ。
    const isRowSeparator = symbol === "\\" || ampersand !== undefined;
    if (isRowSeparator) {
      if (openEnvironments.length === 0) {
        return {
          ok: false,
          reason: "row_separator_outside_environment",
          detail:
            symbol === "\\"
              ? "環境の外の改行(\\\\)は使えません。板書は1手順=1行です"
              : "環境の外の列区切り(&)は使えません",
        };
      }
      continue;
    }

    if (symbol !== undefined && !allowedLatexSymbolCommands.has(`\\${symbol}`)) {
      return {
        ok: false,
        reason: "unknown_command",
        detail: `描画を確認していないコマンド: \\${symbol}`,
      };
    }
  }

  if (openEnvironments.length > 0) {
    return {
      ok: false,
      reason: "unbalanced_environment",
      detail: `\\end{${openEnvironments[openEnvironments.length - 1]}} が閉じられていません`,
    };
  }

  return { ok: true };
}

/**
 * 検査の材料を見たいとき用(テストとログ)。
 * 判定そのものは {@link checkBoardLatex} が持つ。ここは「何が入っていたか」を返すだけ。
 */
export function collectLatexCommands(tex: string): string[] {
  const commands: string[] = [];
  for (const match of tex.matchAll(LATEX_TOKEN)) {
    const [, beginOrEnd, environment, command, symbol] = match;
    if (beginOrEnd !== undefined) commands.push(`\\${beginOrEnd}{${environment}}`);
    else if (command !== undefined) commands.push(`\\${command}`);
    else if (symbol !== undefined) commands.push(`\\${symbol}`);
  }
  return commands;
}

/**
 * 再生成プロンプトに添える指示。**会話の言語で書く**
 * (日本語の指示を英語の授業に混ぜると、次の板書だけ日本語で返ってくるため)。
 *
 * 文面は「何を直せばよいか」まで書く。理由だけ渡しても、LLMは同じ式を出し直す。
 *
 * **どの指示も、行き先が `text` 要素側を向いていること。**
 * 「表せないものは日本語で書くこと」で終えると、LLMは `\text{よって}` を書き、
 * 次のターンで `text_in_math` に落ちる。**指示どうしが循環すると再生成が空回りする**ので、
 * 数式にできないものの行き先は常に「`text` の板書として送る」に揃える。
 */
export const latexRejectionGuidanceByLocale: Record<
  CurriculumLocale,
  Record<LatexRejectionReason, string>
> = {
  ja: {
    unknown_command:
      "その記号は板書に表示できません。基本のコマンド(\\frac \\sqrt \\sum \\int \\vec \\mathrm など)だけで式を書き直すこと。式にできない説明は、数式に混ぜず text の板書として送ること。",
    text_in_math:
      "数式の中に日本語や文章を入れないこと(文字化けします)。「よって」のような一行は、数式ではなく text の板書として送ること。",
    unknown_environment:
      "使える環境は pmatrix(行列)と cases(場合分け)だけ。ほかの環境は使わないこと。",
    unbalanced_environment: "\\begin と \\end を必ず対で書くこと。",
    row_separator_outside_environment:
      "1つの板書は1行。改行(\\\\)を入れず、式を分けたいときは手順を2つに分けること。",
  },
  en: {
    unknown_command:
      "That symbol cannot be drawn on the board. Rewrite the formula using only the basic commands (\\frac, \\sqrt, \\sum, \\int, \\vec, \\mathrm). Anything that cannot be written as a formula goes in a text board element, not in the LaTeX.",
    text_in_math:
      "Do not put words inside a formula. Send a line of prose as a text board element, not as LaTeX.",
    unknown_environment:
      "The only environments available are pmatrix (matrices) and cases. Do not use any other.",
    unbalanced_environment: "Always pair \\begin with \\end.",
    row_separator_outside_environment:
      "One board line per step. Do not use \\\\ — split it into two steps instead.",
  },
};

/** 既定(ロケール未指定)では日本語の説明。 */
export const latexRejectionGuidance: Record<LatexRejectionReason, string> =
  latexRejectionGuidanceByLocale.ja;
