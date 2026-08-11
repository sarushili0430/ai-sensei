import {
  type BoardChannelMessage,
  type BoardStep,
  boardChannelMessageSchema,
  boardChannelTopic,
  boardLessonStepsMaxCount,
  boardProtocolVersion,
  boardStepSchema,
  boardStepsMaxCount,
} from "@ai-sensei/contract";
import {
  type CurriculumLocale,
  type CurriculumSubject,
  subjectOfTopicId,
} from "@ai-sensei/curriculum";
import {
  type AllowedTopics,
  type LatexRejectionReason,
  buildAllowedTopics,
  checkBoardLatex,
  isAllowedTopic,
  latexRejectionGuidanceByLocale,
} from "@ai-sensei/guardrail";
import katex from "katex";
import { BoardLessonStreamParser, BoardStreamError } from "./board-stream.ts";
import type { JobLogger } from "./log.ts";

/**
 * 板書の配送層。LLMのストリーミング出力を、手順が閉じた端から
 * LiveKit の Text Streams(topic `board`)へ1手順ずつ流す。
 *
 * ここが持つのは **配管だけ**。何を板書するか(先輩の口調・教え方・式の組み立て)は
 * プロンプトの責務で、このファイルは一切知らない。逆に、宛先(`session_id`)・
 * 板書の識別(`board_id`)・順序(`seq` / `index`)・締め方(`reason`)は
 * **全部こちらの責務**で、LLMの出力には漏らさない(`contract/src/board.ts` の分担)。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【寿命】板書1枚 = **1つの問題**(1回のLLM呼び出しではない)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 教え方は1往復で終わらない(確定した仕様):
 *
 *   1往復目: 切り分ける(「最初の一手、言ってみて」)→ 答えを聞くためにいったん止まる
 *   生徒が答える
 *   2往復目: 詰まった地点から教える
 *   3往復目: 「じゃあ今の、自分の言葉で説明してみて」
 *
 * **LLM呼び出しごとに板書を開き直すと、会話が1往復するたびに板書が消える。**
 * 契約上、板書が消えるのは `board_open` が来たときだけだから。
 * §3-2 の「前の行は消さない。消えるのは別の問題に移るときだけ」が毎ターン破れ、
 * 「書いたものが残る」という板書の価値そのものが失われる。
 *
 * だから {@link BoardChannel.startBoard} で1枚はじめ、説明のたびに
 * {@link BoardDelivery.append} で同じ `board_id` に積み、問題が終わったら
 * {@link BoardDelivery.close} で締める。**通し番号(`index`)を振り直すのはここ**で、
 * LLMは自分が何回目の呼び出しかを知らない(知らせると幻覚した番号がワイヤーに出る)。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【設計判断】送りながら検証する以上、落ちた手順の手前は取り消せない
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 8手順の板書で、0〜4は送信済み、5手順目の `tex` が `checkBoardLatex` に弾かれた。
 * 送信は取り消せない(板書は積み上げで、消えるのは `board_open` のときだけ)。
 *
 * **採るのは (b) — 落ちた手順だけ直させて、続きを送る。** 上限回数を超えたら
 * **その回の説明だけをやめて、板書は開けたままにする**(そこまでの板書は残り、
 * 次の説明は同じ板書に続けられる)。
 *
 * 理由:
 *
 * 1. **(a) 全部バッファしてから送る、は却下。**§3-2 が案Aを採ったのは
 *    「割り込める・待たされない」ためで、全バッファは案Bそのもの。
 *    覆すだけの根拠は見つからなかった。むしろ逆で、**全バッファは
 *    この問題自体を解かない** — 板書1枚を丸ごと捨てて作り直すことになり、
 *    「1手順の作り直し」より待ち時間が長い。
 *
 * 2. **(b) の待ちは、1手順ぶんの音声と同じ桁。隠れるかどうかは、隠れ蓑を
 *    どこに求めるかで決まる。**
 *
 *    最初ここに「1手順は `speech` 120字 = 約20〜25秒のTTSだから、その裏に隠れる」と
 *    書いた。**これは誤り。120字は契約の上限であって典型値ではない。**
 *    §3-1(音声は問いかけと接続だけ)は `speech` を上限に張り付かせる原則ではなく、
 *    **上限から遠ざける**原則で、実際そうなっている。
 *    実測(`packages/contract/fixtures/board-lesson.json` の7手順):
 *
 *      中央値 14字 ≒ **2.5秒**、最長 29字 ≒ **5.3秒**(日本語TTS 330字/分)
 *      英語のfixture(`board-lesson.en.json`)も 39〜57字 ≒ **2.8〜4.1秒**で同じ帯
 *
 *    **1手順の音声は2〜5秒で、再生成の往復と同じ桁。**上限を根拠にすると
 *    「1手順あたり20秒の余裕がある」という前提が次にここを触る人に残るので、
 *    誤りごと残しておく。
 *
 *    本当の余裕は、**生成がTTSより速いことで積み上がるリード**のほう。
 *    1手順ぶんのJSON(数十トークン)を作る時間は、その手順を読み上げる時間より短い。
 *    差は手順ごとにたまるので、手順5で再生成が要るときの待ちは、
 *    手順0〜4で積み上がったリードから引かれる。
 *    **予測: 授業が進むほどリードは厚くなり、序盤ほど再生成は目立つ。**
 *    最初の手順で落ちたときはリードがゼロで、待ちがそのまま沈黙になる
 *    (§3-2 が「最初の手順までの無音」を事前生成音声で埋めると決めた、あの穴と同じ場所)。
 *
 *    **ただしリードが積み上がる場所は、呼び出し側の {@link AppendBoardOptions.onStep}
 *    の作り方で変わる。**TTSへ渡して即座に返すなら、リードは配送そのものに乗る
 *    (板書が音声を追い越して積まれる)。読み上げ終わりまで待つなら、
 *    §3-2 の「同期の粒度は手順」は守られるが、**リードは生成側にしか残らず、
 *    再生成の往復は音声の空白としてそのまま出る**。後者を採るつもりなら、
 *    再生成の待ちは隠れないものとして扱うこと — {@link defaultMaxRepairAttempts} を
 *    1回にしてあるのはそのため。
 *
 * 3. **既に送った手順は、直後の手順が落ちても無効にならない。**板書は
 *    1手順=1行の積み上げ(§3-2)で、手順4は手順5の下書きではない。
 *    落ちるのは「この式は `flutter_math_fork` が描けない」という**描画の理由**であって、
 *    手順4の内容が間違っていたわけではない。取り消す理由がない。
 *
 * 4. **(c) 板書ごと作り直す、は割に合わない。**ただし (c) の欠点は
 *    「`board_close(error)` を送ると画面がリセットされる」ではない —
 *    契約上、板書が消えるのは **`board_open` が来たときだけ**で、
 *    `board_close` は何も消さない。リセットを起こすのは、そのあとに送る
 *    `board_open` のほう。つまり (c) の本当のコストは
 *    **「生徒が読んでいる途中の板書が、生徒には理由の分からないタイミングで白紙に戻る」**。
 *    §3-2 の「前の行は消さない」を、ユーザーには観測できない内部事情で破ることになる。
 *
 * 5. だから**行き止まりでも板書は閉じない。**再生成が上限に達したら、
 *    その回の `append()` を打ち切って `reason: "error"` を返すだけで、
 *    `board_open` も `board_close` も送らない。板書は途中まで残ったまま開いていて、
 *    **次の説明は同じ板書に続けられる**。先輩は会話(音声)で続けられるし、
 *    画面が変わるのは次の問題に移るときだけ。
 *    **「壊れたら止まる。ただし今あるものは消さないし、次を受け入れる余地も潰さない」**が、
 *    この層の失敗のしかた。
 *
 *    板書ごと閉じる唯一の場合は**上限に達したとき**({@link boardStepsMaxCount})。
 *    そこはもう1手順も積めないので、開けておくと呼び出し側が黒い穴にLLMを呼び続ける。
 *
 * 再生成そのもの(LLMへの投げ直し)は {@link StepRepair} として外に出してある。
 * 落ちた理由に対応する `latexRejectionGuidanceByLocale` の指示文を添えて渡すので、
 * 呼び出し側は「その文をプロンプトに足してもう一度吐かせる」だけでよい。
 * ここに書かないのは、**この層が実鍵なしでテストできる**ことを保つため。
 */

/** 封筒1つを送る先。LiveKit を差し替えられるように、ここで薄く切っている。 */
export type BoardSink = {
  send(message: BoardChannelMessage): Promise<void>;
};

/** `sendText` を持つもの(= `room.localParticipant`)。LiveKit の型に依存しないための構造型。 */
export type TextStreamPublisher = {
  sendText(text: string, options?: { topic?: string }): Promise<unknown>;
};

/**
 * LiveKit の Text Streams へ送る sink。
 *
 * **封筒1つ = 1ストリーム**(§3-5)。`sendText` は1回の呼び出しで
 * ストリームを開いて書いて閉じるので、受信側の `readAll()` がそのまま
 * 「封筒1つが揃った」になる。生の `publishData` は使わない —
 * 既定が LOSSY で、書き忘れると板書が黙って欠ける。
 */
export function createTextStreamBoardSink(publisher: TextStreamPublisher): BoardSink {
  return {
    async send(message) {
      await publisher.sendText(JSON.stringify(message), { topic: boardChannelTopic });
    },
  };
}

/** 手順が検証に落ちた理由。再生成の指示文まで込みで渡す。 */
export type BoardStepRejection = {
  /** 落ちた手順が積まれるはずだった位置(= そのとき送ろうとしていた `index`)。 */
  index: number;
  /**
   * `latex` は描けないコマンド(三段構えの②)、`syntax` は構文の壊れ(③)、
   * `schema` は契約違反(長さ・形)。
   */
  kind: "latex" | "syntax" | "schema";
  reason: LatexRejectionReason | "syntax" | "schema";
  /** 何が引っかかったか(ログ用)。 */
  detail: string;
  /** **会話の言語で書かれた再生成の指示。**そのままプロンプトに足せる。 */
  guidance: string;
  /** 落ちた手順の生の値。直させるときの材料。 */
  raw: unknown;
};

/**
 * 落ちた手順を直させる。直せなければ `null` を返す(そこで板書は `error` で締まる)。
 * 実装はLLM呼び出しになるが、**この層はそれを知らない**(テストではただの関数)。
 */
export type StepRepair = (rejection: BoardStepRejection) => Promise<unknown>;

/**
 * 範囲外の見出しを直させる。直せなければ `null`。
 * 実装はLLM呼び出しになるが、**この層はそれを知らない**(テストではただの関数)。
 */
export type HeadRepair = (rejection: BoardHeadRejection) => Promise<unknown>;

/**
 * **その教科で使ってよい板書要素。**
 *
 * contract は「表現できる形」を全部持っているが、教科ごとに使える枝は違う。
 * 英語の授業に `latex` を許すと、先輩は英文を数式ブロックに入れようとする
 * (`latex-guard` が全角を禁止しているので、そこで初めて弾かれて作り直しになる)。
 * ここで先に閉じておけば、**英語の課程では LaTeX の検査に到達しない**。
 */
const boardKindsBySubject: Record<CurriculumSubject, readonly string[]> = {
  math: ["latex", "text", "plot", "triangle", "circle"],
  english: ["sentence", "compare", "text"],
};

/** 契約に合わなかったときの指示。LaTeXの理由別の文面は guardrail 側にある。 */
const schemaGuidanceBySubject: Record<CurriculumSubject, Record<CurriculumLocale, string>> = {
  math: {
    ja: "手順の形が契約に合っていません。speech は120字以内の話し言葉(数式を入れない)、board は latex / text / plot / triangle / circle のどれか、または null にすること。",
    en: "The step does not match the contract. Keep speech under 120 characters of plain spoken language (no formulas), and make board one of latex / text / plot / triangle / circle, or null.",
  },
  english: {
    ja: "手順の形が契約に合っていません。speech は120字以内の話し言葉、board は sentence(例文) / compare(2列の対比表) / text(一行の注記) のどれか、または null にすること。**英語の板書に数式は置きません。**",
    en: "The step does not match the contract. Keep speech under 120 characters of plain spoken language, and make board one of sentence / compare / text, or null. **Never put formulas on an English board.**",
  },
};

/** その教科で使えない要素が来たときの指示。 */
const wrongKindGuidance: Record<CurriculumSubject, Record<CurriculumLocale, string>> = {
  math: {
    ja: "その要素は数学の板書では使えません。式は latex、図は plot / triangle / circle、注記は text に置くこと。",
    en: "That element cannot be used on a maths board. Put formulas in latex, figures in plot / triangle / circle, and notes in text.",
  },
  english: {
    ja: "その要素は英語の板書では使えません。例文は sentence、使い分けの対比は compare、一行の注記は text に置くこと。数式は使いません。",
    en: "That element cannot be used on an English board. Put example sentences in sentence, contrasts in compare, and one-line notes in text. No formulas.",
  },
};

/**
 * 構文が壊れていたときの指示。**「何を直せばよいか」まで書く**
 * (`latexRejectionGuidanceByLocale` と同じ方針 — 理由だけ渡すと同じ式が返ってくる)。
 */
const syntaxGuidanceByLocale: Record<CurriculumLocale, string> = {
  ja: "数式の構文が壊れています。{ } が対応しているか、\\frac{分子}{分母} や \\sqrt{中身} のように引数を最後まで書いているかを確かめて、式を書き直すこと。",
  en: "The formula does not parse. Check that every { has a matching }, and that commands like \\frac{numerator}{denominator} and \\sqrt{...} have all of their arguments, then rewrite it.",
};

/**
 * 三段構えの③(§3-6)— **KaTeXに実際にパースさせる**。
 *
 * ②(`checkBoardLatex`)はコマンドと環境の**名前**しか見ない。だから
 * `\frac{1}{` のように**許可コマンドだけでできた壊れた式**は素通りする。
 * それが端末に届くと `flutter_math_fork` がその行を描けず、板書が1行
 * 「数式を表示できません」に化ける — 授業の途中で1行消えるのは、遅いより悪い。
 *
 * `flutter_math_fork` はKaTeXのDart移植なので、Node側で本家に通すと構文エラーは事前に捕まる。
 * **②の代わりにはならない**(KaTeXが通しても移植版が対応しているとは限らない)ので、
 * 必ず②を通してから呼ぶこと。
 *
 * `strict: "ignore"` にしてあるのは、ここで見たいのが**構文だけ**だから。
 * 既定の `"warn"` は Unicode などで標準エラーに書き込み、agentのログを汚す
 * (文字種の判定は②の `japaneseCharacters` が既に済ませている)。
 */
export function checkLatexSyntax(tex: string): { ok: true } | { ok: false; detail: string } {
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: false, strict: "ignore" });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type StepVerdict =
  | { ok: true; step: BoardStep }
  | { ok: false; rejection: BoardStepRejection };

/**
 * 手順1つを検証する。**ワイヤーに出る前の最後の関門**。
 *
 * `index` は **LLMの申告を採らず、実際に送る位置で上書きする**。
 * `index` は「板書の何行目に積むか」という配送の事実で、モバイルはこれを
 * `seq` と並ぶ欠落検知に使う(contract README の不変条件の表)。
 * LLMの数え間違いをそのまま流すと、**受信側は正しく届いた板書を「抜けている」と判定する** —
 * 直せる嘘を、検知能力のある場所に置いてしまうことになる。
 * ずれていた事実はログに出す(呼び出し側の {@link BoardChannel} が拾う)。
 */
export function validateStep(
  raw: unknown,
  index: number,
  locale: CurriculumLocale,
  subject: CurriculumSubject = "math",
): StepVerdict {
  const withIndex =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw, index } : raw;

  const parsed = boardStepSchema.safeParse(withIndex);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(" / ");
    return {
      ok: false,
      rejection: {
        index,
        kind: "schema",
        reason: "schema",
        detail,
        guidance: `${schemaGuidanceBySubject[subject][locale]} (${detail})`,
        raw,
      },
    };
  }

  const board = parsed.data.board;

  // **教科で使えない要素は、中身を見る前に落とす。**
  // 英語の板書に latex が来たら、LaTeXの構文を直させても意味がない。
  if (board !== null && !boardKindsBySubject[subject].includes(board.kind)) {
    return {
      ok: false,
      rejection: {
        index,
        kind: "schema",
        reason: "schema",
        detail: `kind=${board.kind} は ${subject} の板書では使えません`,
        guidance: wrongKindGuidance[subject][locale],
        raw,
      },
    };
  }

  // `focus` が `text` の一部であること。**JSON Schema に残らない不変条件**
  // (contract README の表)なので、ここで見る。破れたときの見え方は
  // 「下線が引かれないだけ」で、検査が無いと壊れたまま気づかれない。
  if (board !== null && board.kind === "sentence" && board.focus !== undefined) {
    if (!board.text.includes(board.focus)) {
      return {
        ok: false,
        rejection: {
          index,
          kind: "schema",
          reason: "schema",
          detail: `focus="${board.focus}" が text に含まれていません`,
          guidance:
            locale === "ja"
              ? "focus は text の中から、そのまま切り出した一部にすること(言い換えない)。"
              : "focus must be an exact substring of text — do not paraphrase it.",
          raw,
        },
      };
    }
  }

  if (board !== null && board.kind === "latex") {
    // 三段構えの②(§3-6)。移植版が描けないコマンドは、届いた時点で
    // その行だけ空白か例外になる。授業の途中で1行消えるのは、遅いより悪い。
    const verdict = checkBoardLatex(board.tex);
    if (!verdict.ok) {
      return {
        ok: false,
        rejection: {
          index,
          kind: "latex",
          reason: verdict.reason,
          detail: verdict.detail,
          guidance: latexRejectionGuidanceByLocale[locale][verdict.reason],
          raw,
        },
      };
    }

    // 三段構えの③。**②のあとに置く**(②が名前を、③が構文を見る。順序に意味がある)。
    const syntax = checkLatexSyntax(board.tex);
    if (!syntax.ok) {
      return {
        ok: false,
        rejection: {
          index,
          kind: "syntax",
          reason: "syntax",
          detail: syntax.detail,
          guidance: syntaxGuidanceByLocale[locale],
          raw,
        },
      };
    }
  }

  return { ok: true, step: parsed.data };
}

/**
 * 見出しが範囲外だった理由。手順の {@link BoardStepRejection} と同じ形で持つ。
 */
export type BoardHeadRejection = {
  reason: "topic_not_allowed";
  /** 外れた `topic_id`。**カリキュラムの閉じた語彙**なのでログに出してよい。 */
  detail: string;
  /** **会話の言語で書かれた再生成の指示。**そのままプロンプトに足せる。 */
  guidance: string;
  /** 落ちた見出しの生の値。直させるときの材料。 */
  raw: unknown;
};

export type HeadVerdict = { ok: true } | { ok: false; rejection: BoardHeadRejection };

/** 範囲外の単元を教えようとしたときの指示。理由だけ渡すと同じIDが返ってくる。 */
const topicGuidanceByLocale: Record<CurriculumLocale, (outside: string) => string> = {
  ja: (outside) =>
    [
      `topic_ids に、このセッションの許可リストに無い単元が入っています(${outside})。`,
      "許可リストの中から選び直し、板書の中身もその範囲で組み立て直すこと。",
      "リストには今回の主題とその前提が入っているので、前提に戻るのは構いません。",
    ].join(""),
  en: (outside) =>
    [
      `topic_ids contains a unit that is not in the allowed list for this session (${outside}). `,
      "Pick again from the allowed list, and rebuild the board within that range. ",
      "The list already contains this lesson's target plus its prerequisites, so going back to a prerequisite is fine.",
    ].join(""),
};

/**
 * 見出しの `topic_ids` が、このセッションで教えてよい範囲に入っているか。
 *
 * **ここが無いと、板書だけがガードレールの片翼になる。**
 * README は「サーバ側で出力の `topic_id` をホワイトリスト照合して、外れたものは
 * 再生成させる」= 二重のガードレールと書いていて、カルテ側には
 * `filterHoleTopicIds` がある。契約の `topicIdSchema` は**書式しか見ない**ので、
 * `M9-ARIENAI-TANGEN` のような**形だけ正しい別単元**は素通りしてしまう。
 *
 * 計画書 §8 は topic_id 照合を「**教える範囲の妥当性**」チェックに転用すると
 * 書いていて、板書こそがその対象。ピボット後にガードレールが向くべき先が、
 * いちばん無防備だった。
 *
 * **見出しの時点で見る。**手順を1つも送る前なので、弾いても画面には何も出ていない。
 * 手順を送り始めてからでは、消せないものが既に生徒の画面に載っている。
 */
export function validateHead(
  raw: unknown,
  allowed: AllowedTopics,
  locale: CurriculumLocale,
): HeadVerdict {
  const topicIds = (raw as { topic_ids?: unknown } | null)?.topic_ids;
  // 形が違うものはここでは弾かない。封筒スキーマ(`boardOpenMessageSchema`)が
  // 見るので、二重に判定して食い違わせない。
  if (!Array.isArray(topicIds)) return { ok: true };

  const outside = topicIds.filter(
    (id): id is string => typeof id === "string" && !isAllowedTopic(allowed, id),
  );
  if (outside.length === 0) return { ok: true };

  return {
    ok: false,
    rejection: {
      reason: "topic_not_allowed",
      detail: outside.join(", "),
      guidance: topicGuidanceByLocale[locale](outside.join(", ")),
      raw,
    },
  };
}

export type BoardChannelOptions = {
  sessionId: string;
  locale: CurriculumLocale;
  sink: BoardSink;
  /**
   * このセッションで教えてよい単元。**見出しの照合に使う**({@link validateHead})。
   *
   * `backend/api` が既に前提2段ぶん(`conversationPrerequisiteDepth`)を含めて
   * 載せてくるので、ここで**さらに広げない**(`karte.ts` が
   * `prerequisiteDepth: 0` で組むのと同じ理由)。
   *
   * 省略すると照合しない。テストと、範囲が取れない経路のための逃げ道。
   */
  allowedTopicIds?: readonly string[];
  /**
   * `board_id` の発行。テストから固定値を入れられるようにしてある。
   *
   * 既定はUUID。契約は `z.string().min(1)` しか要求していない(形は契約ではない)。
   * fixtureが `brd_01J8Z9...` というULID風なのは、`backend/api` の `newId()` で
   * 作られたIDの見本だから — あれは別パッケージで、agent からは import できない。
   * 時系列に並ぶIDが欲しくなったら、ここに関数を渡せばよい。
   */
  newBoardId?: () => string;
  log?: Pick<JobLogger, "info" | "warn">;
};

/** 締め方。契約のenumから引く(こちらで書き写すと、増えたときにずれる)。 */
export type BoardCloseReason = Extract<BoardChannelMessage, { type: "board_close" }>["reason"];

/**
 * 封筒の中身から、チャネルが埋める部分(`v` / `session_id` / `seq`)を除いたもの。
 * **`seq` を呼び出し側に書かせない**ための形 — 連番はチャネルだけが持つ。
 */
type BoardEnvelopeBody =
  | { type: "board_open"; board_id: string; title: string; topic_ids: string[] }
  | { type: "board_step"; board_id: string; step: BoardStep }
  | { type: "board_close"; board_id: string; step_count: number; reason: BoardCloseReason };

export type AppendBoardOptions = {
  /** LLMの出力。チャンクの切れ目はどこでもよい(文字列の中・エスケープの中でも壊れない)。 */
  chunks: AsyncIterable<string>;
  /**
   * ユーザーの割り込み。**abort したらこの回の説明を途中でやめる**(§3-2 案Aの利点そのもの)。
   * チャンク待ちの最中でも効くよう、`next()` と競走させている —
   * ポーリングだけだと、LLMが黙り込んだときに止めそこねる。
   *
   * **板書は閉じない。**割り込みは「いま質問がある」であって「この問題は終わり」ではない。
   * ここで閉じると、割り込みに答えたあと同じ問題を続けるときに板書を開き直すことになり、
   * 生徒が読んでいる板書が消える。閉じるのは呼び出し側が {@link BoardDelivery.close} を
   * 呼んだとき(= 問題が終わったとき)だけ。
   */
  signal?: AbortSignal;
  /**
   * 手順を1つ送り終えた直後に呼ぶ。**板書 → 音声の順**(§3-2)を守るための穴で、
   * 呼び出し側はここで `step.speech` をTTSへ渡す。
   *
   * **返すまで次の手順は送らない。**ここに何を待たせるかが、そのまま
   * 同期の粒度になる:
   *
   *   - TTSへ渡して即座に返す → 板書が音声を追い越して積まれる。
   *     再生成の待ちはこのリードに吸収されるが、§3-2 の「同期の粒度は手順」は緩む。
   *   - 読み上げ終わりまで待つ → 手順単位の同期は保たれる。ただし
   *     **再生成の往復は音声の空白としてそのまま出る**(上の設計判断の2)。
   *
   * どちらを採るかはまだ決めていない。W1のドッグフーディングで、
   * 板書が音声より何行先に出ていると読みにくいかを見てから決める値。
   */
  onStep?: (step: BoardStep) => void | Promise<void>;
  repair?: StepRepair;
  /**
   * 範囲外の単元で板書を始めようとしたときに、見出しを作り直させる。
   *
   * **直らなくても板書は止めない。**縮退として記録して、そのまま進む
   * (`append` の中の説明を参照)。`repair` と同じく、この層はLLM呼び出しを知らない。
   */
  repairHead?: HeadRepair;
  /** 1手順あたりの作り直し回数の上限。0にすると再生成しない。 */
  maxRepairAttempts?: number;
};

export type BoardAppendResult = {
  board_id: string;
  /** `board_open` が済んでいるか。**済んでいなければ手順は1つも出ていない**。 */
  opened: boolean;
  /** **この呼び出しで**ワイヤーへ出した手順数。 */
  appended: number;
  /** **板書1枚の合計**。`board_close.step_count` になる値。 */
  step_count: number;
  /** この呼び出しの終わり方。`error` でも板書は開いたまま(下の `closed` を見ること)。 */
  reason: BoardCloseReason;
  /** 板書ごと閉じたか。**上限に達したときだけ true**。 */
  closed: boolean;
  /** 検証に落ちた手順(直って送れたものも含む)。プロンプト調整の材料。 */
  rejections: BoardStepRejection[];
};

/** 割り込みの合図。`iterator.next()` と競走させるための番人。 */
const aborted = Symbol("aborted");

/**
 * 1セッションぶんの板書チャネル。
 *
 * **`seq` はここが持つ**。契約上 `seq` は「セッション内の通し番号(0始まり・
 * 種別をまたいで1ずつ)」なので、板書を跨いで連番になる。板書ごとに
 * リセットすると、2枚目の `board_open` で受信側が「巻き戻った」と見る。
 *
 * **板書1枚の寿命は {@link BoardDelivery} が持つ。**チャネルは
 * 「どの部屋へ、何番目に送るか」だけを知っていて、「いま何を教えているか」は知らない。
 */
export class BoardChannel {
  // コンストラクタ引数への修飾子は使わない(`node --experimental-strip-types`・ADR 0002)。
  private readonly sessionId: string;
  private readonly locale: CurriculumLocale;
  /**
   * 授業の教科。**許可トピックの接頭辞から決まる**(ADR 0007)ので、
   * 呼び出し側が別に持たなくてよい。数学しか無かった頃と同じ既定は `math`。
   */
  private readonly subject: CurriculumSubject;
  private readonly sink: BoardSink;
  private readonly allowedTopics: AllowedTopics | undefined;
  private readonly newBoardId: () => string;
  private readonly log: Pick<JobLogger, "info" | "warn"> | undefined;
  private seq = 0;

  constructor(options: BoardChannelOptions) {
    this.sessionId = options.sessionId;
    this.locale = options.locale;
    this.subject =
      (options.allowedTopicIds?.[0] === undefined
        ? undefined
        : subjectOfTopicId(options.allowedTopicIds[0])) ?? "math";
    this.sink = options.sink;
    // 前提はAPI側で入っているので、ここでは広げない(depth 0)。
    this.allowedTopics =
      options.allowedTopicIds === undefined
        ? undefined
        : buildAllowedTopics(options.allowedTopicIds, { prerequisiteDepth: 0 });
    this.newBoardId = options.newBoardId ?? (() => `brd_${crypto.randomUUID()}`);
    this.log = options.log;
  }

  /** 次に送る封筒の `seq`(テストと検算用)。 */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * 板書を1枚はじめる。**単位は「1つの問題」であって「1回の説明」ではない。**
   *
   * この時点ではまだ何も送らない。`board_open` は最初の {@link BoardDelivery.append} で、
   * LLMが出した `title` / `topic_ids` を使って送る — 見出しは「何の問題か」なので、
   * 問題を見ているLLMにしか書けない。
   */
  startBoard(): BoardDelivery {
    return new BoardDelivery({
      boardId: this.newBoardId(),
      locale: this.locale,
      subject: this.subject,
      allowedTopics: this.allowedTopics,
      log: this.log,
      send: (body) => this.sendEnvelope(body),
    });
  }

  /**
   * 封筒を1つ送る。`v` / `session_id` / `seq` はここで埋める。
   *
   * **送る直前に封筒スキーマで自分を検算する。**配送層のバグ(`seq` の付け間違い・
   * 板書IDの取り違え)は、トランスポートからは正常に見えるので、
   * ここで落とさないと誰も気づかない。
   *
   * `seq` を進めるのは **送れたあと**。失敗した封筒でも番号を消費すると、
   * 受信側からは「1つ欠けた板書」に見えて、次の手順まで巻き添えにする。
   */
  private async sendEnvelope(body: BoardEnvelopeBody): Promise<void> {
    const validated = boardChannelMessageSchema.parse({
      v: boardProtocolVersion,
      session_id: this.sessionId,
      seq: this.seq,
      ...body,
    });
    await this.sink.send(validated);
    this.seq += 1;
  }
}

type BoardDeliveryOptions = {
  boardId: string;
  locale: CurriculumLocale;
  /** 授業の教科。省略すると数学(それしか無かった頃と同じ挙動)。 */
  subject?: CurriculumSubject;
  allowedTopics: AllowedTopics | undefined;
  log: Pick<JobLogger, "info" | "warn"> | undefined;
  send: (body: BoardEnvelopeBody) => Promise<void>;
};

/**
 * 板書1枚 = **1つの問題**。
 *
 * ライフサイクルは `append()` × n → `close(reason)`。
 * `board_open` は最初の `append()` が1回だけ送り、以降の説明は同じ `board_id` に積む。
 *
 * **`append()` は板書を閉じない。**1回の説明が割り込まれても、検証で落ちても、
 * 板書は開いたままで次の説明を待つ。これは §3-2 の「前の行は消さない。消えるのは
 * 別の問題に移るときだけ」を、**配送層の失敗まで含めて**守るため —
 * 説明が1回失敗しただけで閉じると、次の説明で板書を開き直すことになり、
 * 生徒が読んでいた式が「生徒には理由の分からないタイミングで」消える。
 *
 * 例外は**上限に達したとき**だけ。それ以上1手順も積めない板書を開けておくと、
 * 呼び出し側は黒い穴に向かってLLMを呼び続ける。そこは閉じて止める。
 */
export class BoardDelivery {
  private readonly boardId: string;
  private readonly locale: CurriculumLocale;
  /** その授業の教科。板書に使ってよい要素を決める。 */
  private readonly subject: CurriculumSubject;
  private readonly allowedTopics: AllowedTopics | undefined;
  private readonly log: Pick<JobLogger, "info" | "warn"> | undefined;
  private readonly send: (body: BoardEnvelopeBody) => Promise<void>;

  private opened = false;
  private closed = false;
  /** 板書1枚で送った手順数。**ワイヤーの `index` はこの値**(LLMの申告ではない)。 */
  private sent = 0;

  constructor(options: BoardDeliveryOptions) {
    this.boardId = options.boardId;
    this.locale = options.locale;
    this.subject = options.subject ?? "math";
    this.allowedTopics = options.allowedTopics;
    this.log = options.log;
    this.send = options.send;
  }

  get id(): string {
    return this.boardId;
  }

  /** 板書1枚で送った手順数。次に積む手順の `index` でもある。 */
  get stepCount(): number {
    return this.sent;
  }

  /**
   * `board_open` を送り、まだ締めていない状態。
   *
   * **「まだ積めるか」を聞きたいときはこれではなく {@link isClosed} を見ること。**
   * 板書を始めた直後は `board_open` をまだ送っていない(見出しはLLMの最初の出力から取る)ので、
   * `isOpen` は false のまま — それでも `append()` は当然できる。
   */
  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /** 締めたあと。**ここが true なら `append()` は1件もワイヤーに出さない。** */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 1回ぶんの説明を、同じ板書に積む。
   *
   * ストリームを食べながら、手順が閉じた端から送る(§3-2 案A)。
   * 最初の呼び出しだけ `board_open` を出し、2回目以降はLLMが付けてくる
   * `title` / `topic_ids` を**捨てる** — そこで開き直すと板書が消える。
   */
  async append(options: AppendBoardOptions): Promise<BoardAppendResult> {
    const {
      chunks,
      signal,
      onStep,
      repair,
      repairHead,
      maxRepairAttempts = defaultMaxRepairAttempts,
    } = options;

    const rejections: BoardStepRejection[] = [];
    const before = this.sent;
    let reason: BoardCloseReason = "completed";

    if (this.closed) {
      // 上限で閉じた板書に積もうとした。呼び出し側は知らずに呼びうるので、
      // 例外にせず「積めなかった」と返す(会話は音声で続けられる)。
      this.log?.warn("board_append_after_close", { board_id: this.boardId, step_count: this.sent });
      return this.result({ reason: "error", before, rejections });
    }

    const parser = new BoardLessonStreamParser();
    /** ヘッダ(title / topic_ids)より先に閉じた手順の待避所。 */
    const pending: unknown[] = [];
    /** **この呼び出しの中での**位置。LLMの申告と突き合わせるのはこちら。 */
    let position = 0;
    /**
     * 見出し。**受け取っても、すぐには `board_open` を送らない**(下の `openIfNeeded`)。
     * 送るのは最初の手順が検証を通ってから。
     */
    let head: { title: unknown; topic_ids: unknown } | null = null;

    const iterator = chunks[Symbol.asyncIterator]();

    try {
      consume: while (true) {
        const next = await nextOrAbort(iterator, signal);
        if (next === aborted) {
          reason = "interrupted";
          break;
        }
        if (next.done === true) break;

        for (const event of parser.feed(next.value)) {
          if (event.type === "lesson_head") {
            // 2回目以降の見出しは捨てる。**ここで開き直すと板書が消える。**
            if (this.opened) {
              this.log?.info("board_head_ignored", {
                board_id: this.boardId,
                title: event.title,
              });
              continue;
            }
            head = await this.settleHead(
              { title: event.title, topic_ids: event.topic_ids },
              repairHead,
              maxRepairAttempts,
            );
            continue;
          }
          pending.push(event.raw);
        }

        // 見出しが来るまでは手順を出せない(`board_open` が先に要る)。
        if (head === null && !this.opened) continue;

        while (pending.length > 0) {
          if (signal?.aborted === true) {
            reason = "interrupted";
            break consume;
          }

          // 板書1枚の上限。ここに達したら**板書ごと閉じる**(下の finally 後の処理)。
          // これ以上1手順も積めないので、開けておくと呼び出し側が黒い穴にLLMを呼び続ける。
          if (this.sent >= boardStepsMaxCount) {
            this.log?.warn("board_steps_overflow", {
              board_id: this.boardId,
              step_count: this.sent,
            });
            reason = "error";
            break consume;
          }

          // 1回の出力の上限。**「1行ずつだが40行」で答案を丸ごと流し込む抜け道**
          // (contract の `boardLessonStepsMaxCount`)を、送る前に閉じる。
          // 板書は閉じない — 次の説明はまだこの板書に積める。
          if (position >= boardLessonStepsMaxCount) {
            this.log?.warn("board_lesson_overflow", {
              board_id: this.boardId,
              appended: this.sent - before,
            });
            reason = "error";
            break consume;
          }

          const raw = pending.shift();
          const verdict = await this.settleStep({
            raw,
            index: this.sent,
            position,
            repair,
            maxRepairAttempts,
            rejections,
          });

          if (!verdict.ok) {
            // 直らなかった。**この回の説明だけをやめる。板書は開けたまま**にして、
            // 次の説明を待つ(閉じると、次の説明で板書が消える)。
            this.log?.warn("board_step_rejected", {
              board_id: this.boardId,
              index: verdict.rejection.index,
              reason: verdict.rejection.reason,
              detail: verdict.rejection.detail,
            });
            reason = "error";
            break consume;
          }

          // **手順が1つ確定してから板書を開く。**`board_open` は前の板書を消す信号なので、
          // 中身が1行も無い出力(`steps: []`)や、最初の手順から検証に落ちる出力で
          // これを送ると、**生徒が読んでいた板書を白紙にしただけで終わる**。
          // 開くのを1手順ぶん遅らせるコストは見出しの表示が数百ms遅れることだけ。
          await this.openIfNeeded(head);

          await this.send({
            type: "board_step",
            board_id: this.boardId,
            step: verdict.step,
          });
          this.sent += 1;
          position += 1;

          // 板書を出してから喋る(§3-2)。ここで待つのは意図的で、
          // 音声が板書を追い越すと「ここ、見て」が空の盤面を指すことになる。
          await onStep?.(verdict.step);
        }
      }

      // ルートの `}` まで読めていない = 途中で切れた出力。送った手順は有効だが、
      // 「1回ぶん全部送った」とは言えないので `completed` にはしない。
      if (reason === "completed" && !parser.completed) {
        this.log?.warn("board_stream_truncated", {
          board_id: this.boardId,
          appended: this.sent - before,
        });
        reason = "error";
      }

      // 最後まで読めたのに1手順も積めなかった = 契約違反の出力。
      // `boardLessonSchema` は `steps` を1件以上に縛っているので、
      // 「読み切れたが空だった」は成功ではない。1件も送っていないぶん受信側には
      // 何も起きないが、**成功として返してはいけない** —
      // 呼び出し側が「板書は出た」と思って音声だけ進めてしまう。
      if (reason === "completed" && this.sent === before) {
        this.log?.warn(head === null ? "board_head_missing" : "board_lesson_empty", {
          board_id: this.boardId,
          opened: this.opened,
        });
        reason = "error";
      }
    } catch (error) {
      // 走査の破綻(`BoardStreamError`)・封筒の契約違反・送信の失敗。
      // どれも「この回は待っても直らない」が、**板書そのものは生きている**。
      reason = "error";
      this.log?.warn("board_append_failed", {
        board_id: this.boardId,
        appended: this.sent - before,
        stream_error: error instanceof BoardStreamError,
        message: error instanceof Error ? error.message : String(error),
      });
      releaseIterator(iterator);
    }

    if (reason === "interrupted") releaseIterator(iterator);

    // 上限に達した板書だけは、ここで閉じる。
    if (this.opened && !this.closed && this.sent >= boardStepsMaxCount) {
      await this.close("error");
    }

    return this.result({ reason, before, rejections });
  }

  /**
   * まだ開いていなければ `board_open` を送る。**最初の手順が確定した時点で呼ぶ。**
   *
   * 見出しを受け取った時点では送らない理由は、呼び出し元のコメントを参照
   * (空の出力で生徒の板書を白紙にしないため)。
   */
  private async openIfNeeded(head: { title: unknown; topic_ids: unknown } | null): Promise<void> {
    if (this.opened || head === null) return;
    await this.send({
      type: "board_open",
      board_id: this.boardId,
      // 型は封筒スキーマが見る。LLMが変な値を入れたらここで落ちて、
      // 板書は開かない(壊れた板書を開くよりよい)。
      title: head.title as string,
      topic_ids: head.topic_ids as string[],
    });
    this.opened = true;
    this.log?.info("board_opened", { board_id: this.boardId, title: head.title });
  }

  /**
   * 板書を締める。**問題が終わったときに呼ぶ**(1回の説明が終わったときではない)。
   *
   * `board_open` を送っていなければ何も送らない — 開いていない板書の `board_close` は
   * 受信側が「未開封」として捨てるので、`seq` を無駄に進めるぶん害がある。
   * 2回目以降の呼び出しは何もしない(締めの二重送信は受信側で契約違反になる)。
   *
   * **送れなかったときは閉じたことにしない。**受信側から見ると板書はまだ開いたままで、
   * 次の問題の `board_open` を「前の板書が board_close されていません」で弾く —
   * つまり1回の送信失敗で、**そのセッションの板書が以降ぜんぶ出なくなる**。
   * 締められなかった事実を状態に残して、呼び出し側が締め直せるようにする
   * (`send` は成功したときしか `seq` を進めないので、送り直しても番号は飛ばない)。
   */
  async close(reason: BoardCloseReason): Promise<void> {
    if (this.closed) return;
    if (!this.opened) {
      this.closed = true;
      return;
    }

    try {
      // `step_count` は**板書1枚で実際に送った数**。末尾の欠落はこれでしか検知できない。
      await this.send({
        type: "board_close",
        board_id: this.boardId,
        step_count: this.sent,
        reason,
      });
      this.closed = true;
    } catch (error) {
      this.log?.warn("board_close_failed", {
        board_id: this.boardId,
        step_count: this.sent,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private result(input: {
    reason: BoardCloseReason;
    before: number;
    rejections: BoardStepRejection[];
  }): BoardAppendResult {
    return {
      board_id: this.boardId,
      opened: this.opened,
      appended: this.sent - input.before,
      step_count: this.sent,
      reason: input.reason,
      closed: this.closed,
      rejections: input.rejections,
    };
  }

  /**
   * 見出しを、必要なら直させながら確定させる。**弾いても板書は止めない。**
   *
   * 範囲外の単元で教え始めるのは、写真に無い話を教えることなので直させる。
   * だが**直らなかったときに板書を殺してはいけない** — 生徒は15分の授業を
   * 丸ごと失う。範囲が少しずれた板書のほうが、板書が出ないよりまし。
   * だから最後は**元の見出しをそのまま返して進む**(縮退としてログに残す)。
   *
   * 許可集合が渡されていなければ素通し(テストと、範囲が取れない経路)。
   */
  private async settleHead(
    head: { title: unknown; topic_ids: unknown },
    repairHead: HeadRepair | undefined,
    maxRepairAttempts: number,
  ): Promise<{ title: unknown; topic_ids: unknown }> {
    const allowed = this.allowedTopics;
    if (allowed === undefined) return head;

    let candidate: { title: unknown; topic_ids: unknown } = head;

    for (let attempt = 0; ; attempt += 1) {
      const verdict = validateHead(candidate, allowed, this.locale);
      if (verdict.ok) return candidate;

      this.log?.warn("board_topics_rejected", {
        board_id: this.boardId,
        // 外れたIDはカリキュラムの閉じた語彙。頻発するならプロンプト側を直す材料になる。
        reason: verdict.rejection.reason,
        detail: verdict.rejection.detail,
        attempt,
      });

      if (repairHead === undefined || attempt >= maxRepairAttempts) return head;

      let repaired: unknown;
      try {
        repaired = await repairHead(verdict.rejection);
      } catch {
        return head;
      }
      if (repaired === null || repaired === undefined) return head;
      if (typeof repaired !== "object" || Array.isArray(repaired)) return head;
      candidate = repaired as { title: unknown; topic_ids: unknown };
    }
  }

  /**
   * 手順1つを、必要なら直させながら確定させる。
   * **落ちた手順はここから外に出ない** — 呼び出し側は `ok` のものしか送らない。
   */
  private async settleStep(input: {
    raw: unknown;
    /** ワイヤーに出す `index`(板書1枚での通し番号)。 */
    index: number;
    /** この呼び出しの中での位置。LLMの申告と突き合わせるのはこちら。 */
    position: number;
    repair: StepRepair | undefined;
    maxRepairAttempts: number;
    rejections: BoardStepRejection[];
  }): Promise<StepVerdict> {
    const { raw, index, position, repair, maxRepairAttempts, rejections } = input;
    let candidate = raw;

    for (let attempt = 0; ; attempt += 1) {
      const verdict = validateStep(candidate, index, this.locale, this.subject);
      if (verdict.ok) {
        this.warnIfIndexMoved(candidate, position, index);
        return verdict;
      }

      rejections.push(verdict.rejection);
      if (repair === undefined || attempt >= maxRepairAttempts) return verdict;

      try {
        const repaired = await repair(verdict.rejection);
        if (repaired === null || repaired === undefined) return verdict;
        candidate = repaired;
      } catch {
        // 直させる側が落ちたら、それ以上は粘らない(会話は音声で続けられる)。
        return verdict;
      }
    }
  }

  /**
   * LLMが数え間違えた事実だけを残す。
   *
   * **突き合わせる相手は `position`(その出力の中での位置)であって、
   * ワイヤーの `index` ではない。**LLMは自分が何回目の呼び出しかを知らないので、
   * 2回目の説明では必ず0から数え直してくる — それは正しい振る舞いで、
   * ワイヤーの通し番号とずれているのは当たり前。ここでワイヤー側と比べると、
   * **2回目以降の全手順に警告が出て、本物の数え間違いが埋もれる。**
   */
  private warnIfIndexMoved(raw: unknown, position: number, index: number): void {
    if (typeof raw !== "object" || raw === null) return;
    const declared = (raw as { index?: unknown }).index;
    if (typeof declared === "number" && declared !== position) {
      this.log?.warn("board_step_index_overridden", { declared, position, index });
    }
  }
}

/**
 * 作り直しの既定回数。**1回**。
 *
 * はじめ2回にしていたが、1手順の音声が**2〜5秒**(上の実測)と分かった時点で
 * 割に合わなくなった。訂正後の数字から導くとこうなる:
 *
 *   - 再生成1回(数秒)は、体感で**手順1つぶんの間**にあたる。息継ぎに聞こえる範囲。
 *   - 2回だと手順1つを丸ごと超える沈黙になる。この長さは、このアプリでは既に
 *     一度バグとして扱われている領域(`closingGraceMs = 2500` は「切れて聞こえない」ための
 *     **最小の**余白で、2.5秒が黙って許される長さではないことの裏返し)。
 *   - そして**2回目に渡す材料は1回目と同じ**。`latexRejectionGuidanceByLocale` は
 *     理由ごとに固定の文面で、行き先まで書いてある(「`text` の板書として送れ」)。
 *     1回目で直らなかったのは、その指示が効かない書き方をしているということで、
 *     同じ指示をもう一度渡しても同じ失敗の族に落ちる。**新しい情報のない再試行に、
 *     手順1つぶんの沈黙を払う理由がない。**
 *
 * 呼び出し側は `maxRepairAttempts` で上書きできる。指示文が枝分かれして
 * 「2回目は別の言い方をする」形になったら、そのときは2回に戻す価値が出る。
 */
export const defaultMaxRepairAttempts = 1;

/**
 * 次のチャンクか、割り込みか、早く来たほうを返す。
 *
 * `for await` のポーリングにしないのは、**LLMが黙り込んだときに割り込みを取りこぼす**から。
 * 割り込みは「次のチャンクが来たら気づく」では遅い — 生徒はもう喋っている。
 */
async function nextOrAbort(
  iterator: AsyncIterator<string>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<string> | typeof aborted> {
  if (signal === undefined) return iterator.next();
  if (signal.aborted) return aborted;

  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<typeof aborted>((resolve) => {
    onAbort = () => resolve(aborted);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  // 割り込みが勝つと、この next() は誰も待たないまま残る。
  // あとで落ちると unhandled rejection でプロセスごと落ちるので、先に手当てする。
  const next = iterator.next();
  next.catch(() => undefined);

  try {
    return await Promise.race([next, interrupted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 上流(LLMのストリーム)を離す。
 *
 * **待たない。**割り込みで抜けるとき、上流は `await` の途中で止まっていることがあり、
 * その状態の async generator に `return()` を投げても**その await が解けるまで返ってこない**
 * (LLMが黙り込んだままなら永久に返らない)。ここで待つと、割り込みの目的である
 * `board_close` が送れなくなる — 生徒はもう喋っているのに板書が締まらない。
 * 後片付けは best effort に留める。
 */
function releaseIterator(iterator: AsyncIterator<string>): void {
  iterator.return?.().catch(() => undefined);
}
