import type { BoardStep, CompleteSessionRequest } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import type {
  AppendBoardOptions,
  BoardAppendResult,
  BoardCloseReason,
  BoardHeadRejection,
  BoardStepRejection,
} from "./board.ts";
import { extractJson } from "./complete.ts";
import type { JobLogger } from "./log.ts";
import { stepAwaitsInput, stepAwaitsSolving } from "./senpai.ts";

/**
 * フェーズ1「授業」— 板書レッスンの生成と、手順単位の配送・読み上げ。
 *
 * 板書の**配管**は `board.ts`(封筒・seq・寿命)、**走査**は `board-stream.ts`。
 * ここが持つのは、その2つと Anthropic のストリーミングを繋ぐ**上流側**だけ:
 *
 *   Anthropic のSSE → テキストのチャンク列 → BoardDelivery.append() → onStep で読み上げ
 *
 * LiveKit の型には依存しない({@link RunBoardLessonOptions.speak} が薄い穴)。
 * 実鍵なしでテストできる状態を保つのは `board.ts` と同じ方針。
 */

/**
 * 板書レッスン1回ぶんのトークン上限。
 *
 * 手順12件(`boardLessonStepsMaxCount`)× (`speech` 120字 + `tex` 200字)の
 * JSONでも数KB。日本語は1文字あたり1トークンを超えるので余裕を持って4000。
 * ここを絞りすぎると `steps` の途中で `max_tokens` に当たり、
 * ルートの `}` まで読めずに `board_stream_truncated` になる。
 */
export const boardLessonMaxTokens = 4000;

/** 作り直しは手順1つぶん。レッスン全体の上限を使わせない。 */
export const boardRepairMaxTokens = 600;

/**
 * ストリーム1本の上限時間。
 *
 * 返事の来ない接続を掴んだままだと、生徒の前で板書が止まったまま何も起きない。
 * 上限秒数(無料5分)より短くしておかないと、打ち切りより先にセッションが終わる。
 */
export const boardStreamTimeoutMs = 60_000;

export type LessonStreamInput = {
  system: string;
  /**
   * systemの末尾に足す、**キャッシュの印より後ろ**のひとこと。
   *
   * パスごとに変わる事実(残り時間)の置き場。`system` に混ぜると4万字級の指示文が
   * まるごとキャッシュから外れるので、分けて渡す({@link createAnthropicLessonClient})。
   */
  systemTail?: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
};

/**
 * 板書を吐くLLM。**ストリーミングだけを持つ。**
 *
 * 一括で受け取る口を用意しないのは、計画書 §3-2 の案B(全部生成してから再生)へ
 * 落ちる経路を作らないため。作り直し({@link StepRepair})も同じ口を使って、
 * 出てきたテキストを呼び出し側で溜める。
 */
export type LessonLlm = {
  stream(input: LessonStreamInput): AsyncIterable<string>;
};

export type AnthropicLessonOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * 入力トークンの内訳。**プロンプトキャッシュが効いているかの唯一の観測点。**
   *
   * 会話LLMは `voice_metrics` の `cached_tokens`(プラグインのメトリクス)で見られるが、
   * 板書LLMは素の `fetch` なので、ここで出さないと誰も見ていない数字になる。
   */
  onUsage?: (usage: LessonLlmUsage) => void;
};

/** `message_start` が持つ入力トークンの内訳(欠けている項目は0で埋める)。 */
export type LessonLlmUsage = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

/**
 * Anthropic Messages API のストリーミング(SSE)から、テキストのデルタだけを取り出す。
 *
 * `karte.ts` の `createAnthropicClient` と同じく素の `fetch` で書いてある。
 * 公式SDKを使わないのは、**`backend/agent` の依存に `@anthropic-ai/sdk` が無い**から
 * (`package.json` はこの作業の担当範囲外)。入れるなら差し替える価値はある。
 *
 * **`thinking` を明示的に切っている。**既定でadaptive thinkingが入るモデル
 * (Sonnet 5 など)だと、最初の1手順が出るまでに思考時間が丸ごと乗る。
 * その待ちは計画書 §3-2 が「冒頭の無音」として名指ししている穴そのもので、
 * 板書では**沈黙の長さ = 生成の待ち時間**になる。
 * モデルを差し替えるときは、その版が `thinking: {type: "disabled"}` を
 * 受け付けるかを確かめること(古い版では受け付けない可能性がある)。
 * `output_config.effort` は送っていない — 受け付けないモデルがあり、
 * モデル名を1つ変えただけで授業が丸ごと落ちるのは割に合わない。
 */
export function createAnthropicLessonClient(options: AnthropicLessonOptions): LessonLlm {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const timeoutMs = options.timeoutMs ?? boardStreamTimeoutMs;

  return {
    async *stream({ system, systemTail, user, maxTokens, signal }) {
      // 割り込みでも上限時間でも、**HTTPごと切る**。
      // イテレータを離すだけだと接続は生きたままで、聞かれない板書の
      // 出力トークンを払い続ける(§6-1 の LLM 費目がそのぶん膨らむ)。
      const deadline = AbortSignal.timeout(timeoutMs);
      const aborter = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

      const response = await doFetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: maxTokens,
          stream: true,
          thinking: { type: "disabled" },
          // **指示文にプロンプトキャッシュの印を付ける。**
          //
          // `senpai_board.ja.md` は43KBで、会話側(11KB)の4倍。しかも
          // `senpai.ts` の設計どおり**systemは毎パス同じ正本**で、往復は最大6回
          // (`defaultMaxLessonPasses`)。つまり最も効く形をしていて、
          // 付けるまでは毎回まるごと再送していた。
          //
          // 効くのはTTFTと原価の両方だが、**この授業で先に見えるのはTTFT** —
          // §3-2 が「最初の手順までの無音」と呼んだ沈黙が、そのまま短くなる。
          // キャッシュ読みの単価は通常入力の 0.1 倍、書き込みは 1.25 倍。
          //
          // ブロック配列にするのは `cache_control` を置くため(文字列のままでは置けない)。
          // 印は system の**最後のブロック**に1つ。Anthropic はキャッシュを
          // 「印までのプレフィックス」として扱うので、これで system 全体が載る
          // (`conversation-llm.ts` と同じ理由・同じ置き方)。
          //
          // **効きは `onUsage` で見ること。** `cache_read_input_tokens` が0のまま
          // 動かないなら、systemがパスごとに変わっている(残り時間を埋め込む
          // `system()` の作りを疑う)か、最小長を割っている。
          system: [
            { type: "text", text: system, cache_control: { type: "ephemeral" } },
            // 印より**後ろ**。ここが毎パス変わってもプレフィックスは壊れない。
            ...(systemTail === undefined ? [] : [{ type: "text", text: systemTail }]),
          ],
          messages: [{ role: "user", content: user }],
        }),
        signal: aborter,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`板書の生成に失敗しました: ${response.status} ${detail}`);
      }
      if (response.body === null) {
        throw new Error("板書の生成にレスポンス本文がありません");
      }

      yield* readTextDeltas(response.body, options.onUsage);
    },
  };
}

/**
 * SSEのバイト列から `text_delta` のテキストだけを流す。
 *
 * **イベントの区切り(空行)は待たない。**Anthropic のSSEは1イベントにつき
 * `data:` 行が1本なので、行が閉じた時点でその中身は完成している。
 * ここで空行まで待つ設計にすると、`board-stream.ts` が「手順が閉じた端から出す」
 * ために稼いだレイテンシを、1行ぶんとはいえ手前で食い潰すことになる。
 *
 * チャンクは行の途中で切れる(`decode(..., { stream: true })` がマルチバイトを跨ぐ)。
 * 残りはバッファに持ち越すだけで、下流の走査器と同じくチャンク境界を特別扱いしない。
 */
export async function* readTextDeltas(
  body: ReadableStream<Uint8Array>,
  onUsage?: (usage: LessonLlmUsage) => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const event = eventOfSseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event?.type === "text") yield event.text;
        // 観測は本流を止めない。呼び出し側のログが投げても板書は続ける。
        if (event?.type === "usage" && onUsage !== undefined) {
          try {
            onUsage(event.usage);
          } catch {
            // ここで落ちるのは観測側の都合。授業には関係がない。
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    // 割り込みで抜けるときも上流を離す(HTTPは `signal` 側で切れている)。
    reader.releaseLock();
  }
}

/** SSEの1行から読み取れたもの。テキストのデルタか、`message_start` の使用量。 */
type LessonSseEvent = { type: "text"; text: string } | { type: "usage"; usage: LessonLlmUsage };

/**
 * SSEの1行を読む。テキストのデルタか使用量なら中身、それ以外は `null`。
 *
 * **壊れた `data:` 行は握り潰さずに投げる。**黙って読み飛ばすと、
 * 手順が1つ減ったまま板書が「完成」してしまう(`board-stream.ts` が
 * steps の要素型を検査しているのと同じ理由)。
 */
function eventOfSseLine(line: string): LessonSseEvent | null {
  const trimmed = line.trim();
  // `event:` 行・空行・`: ping` のコメント行はここで落ちる。
  if (!trimmed.startsWith("data:")) return null;

  const payload = trimmed.slice("data:".length).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `板書のSSEが読めません: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof event !== "object" || event === null) return null;
  const typed = event as { type?: unknown; delta?: unknown; error?: unknown };

  if (typed.type === "error") {
    const detail = typed.error as { message?: unknown } | undefined;
    throw new Error(
      `板書の生成がエラーで止まりました: ${
        typeof detail?.message === "string" ? detail.message : JSON.stringify(typed.error)
      }`,
    );
  }

  // 入力トークンの内訳は `message_start` にしか載らない(以降は出力側だけ)。
  if (typed.type === "message_start") {
    const usage = (typed as { message?: { usage?: unknown } }).message?.usage;
    return usage === undefined ? null : { type: "usage", usage: readUsage(usage) };
  }

  if (typed.type !== "content_block_delta") return null;
  const delta = typed.delta as { type?: unknown; text?: unknown } | undefined;
  if (delta?.type !== "text_delta" || typeof delta.text !== "string") return null;
  return { type: "text", text: delta.text };
}

/** 数でない項目は0として読む(モデルによっては欠ける。観測が理由で授業を止めない)。 */
function readUsage(usage: unknown): LessonLlmUsage {
  const fields = usage as Record<string, unknown>;
  const count = (name: string): number => {
    const value = fields[name];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    input_tokens: count("input_tokens"),
    cache_creation_input_tokens: count("cache_creation_input_tokens"),
    cache_read_input_tokens: count("cache_read_input_tokens"),
  };
}

/** 板書を出す指示。systemと同じ言語で頼む(混ぜると出力の言語が揺れる)。 */
const lessonInstruction: Record<CurriculumLocale, string> = {
  // 「問題」と呼ばない。復習は写真なしで、前回の穴そのものを教え直す授業だから。
  ja: "この授業の板書レッスンのJSONだけを返してください。",
  en: "Return only the board lesson JSON for this lesson.",
};

/**
 * 落ちた手順を作り直させる指示。
 *
 * **「手順1つだけ」と明示する。**ここでレッスン全体の形(`{title, topic_ids, steps}`)を
 * 返されると、`validateStep` は `boardStepSchema` で見ているので必ずもう一度落ちる。
 */
const repairInstruction: Record<CurriculumLocale, (rejection: BoardStepRejection) => string> = {
  ja: (rejection) =>
    [
      "直前の板書の手順が検証に落ちました。**その手順1つだけ**を書き直してください。",
      "返すのは手順1つのJSONオブジェクト(`index` / `speech` / `board`)だけです。",
      "配列にしない、前置きを書かない、コードフェンスで囲まない。",
      // 直しがいちばん安い道へ落ちるのを塞ぐ(`board.ts` の schemaGuidance と同じ理由)。
      "**`board` を `null` にして逃げないこと。**書くはずだったものを消すと、この手順は板書に何も残しません。",
      "",
      `落ちた理由: ${rejection.guidance}`,
      `落ちた手順: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
  en: (rejection) =>
    [
      "The board step below failed validation. Rewrite **only that one step**.",
      "Return a single step JSON object (`index` / `speech` / `board`) and nothing else.",
      "No array, no preamble, no code fence.",
      "**Do not fall back to `board: null`** — dropping it leaves nothing on the board for this step.",
      "",
      `Why it failed: ${rejection.guidance}`,
      `The step that failed: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
};

/**
 * 範囲外の単元で板書を始めようとしたときの指示。
 *
 * **見出しだけを直させる。**ここでレッスン全体を返されると、走査済みの手順と
 * 二重になる(見出しは `steps` より先に閉じるので、まだ手順は1つも出ていない)。
 */
const headRepairInstruction: Record<CurriculumLocale, (rejection: BoardHeadRejection) => string> = {
  ja: (rejection) =>
    [
      "板書の見出しが、このセッションの許可トピックから外れています。**見出しだけ**を書き直してください。",
      "返すのは `title` と `topic_ids` だけのJSONオブジェクト1つです。",
      "`steps` は入れない、前置きを書かない、コードフェンスで囲まない。",
      "",
      `直す理由: ${rejection.guidance}`,
      `落ちた見出し: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
  en: (rejection) =>
    [
      "The board title is outside the allowed topics for this session. Rewrite **only the head**.",
      "Return a single JSON object with just `title` and `topic_ids`.",
      "No `steps`, no preamble, no code fence.",
      "",
      `Why: ${rejection.guidance}`,
      `The head that failed: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
};

/** 板書1枚(`BoardChannel.startBoard()` が返すもの)のうち、授業で使う口だけ。 */
export type BoardLessonDelivery = {
  append(options: AppendBoardOptions): Promise<BoardAppendResult>;
};

export type RunBoardLessonOptions = {
  llm: LessonLlm;
  /** `boardLessonSystemPrompt()` の出力。**パスをまたいで同じ正本**であること。 */
  system: string;
  /** 残り時間のひとこと(`senpaiBoardRemainingNote()`)。キャッシュの印より後ろに載る。 */
  systemTail?: string;
  locale: CurriculumLocale;
  delivery: BoardLessonDelivery;
  /**
   * 板書を1行出した**直後**に呼ばれる。ここでTTSに渡す。
   *
   * **返るまで次の手順は送らない**(`board.ts` の `onStep` の契約)。
   * 読み上げ終わりまで待つか、投げて即返すかで同期の粒度が変わる。判断は `agent.ts` 側。
   */
  speak: (step: BoardStep) => Promise<void>;
  signal?: AbortSignal;
  log?: Pick<JobLogger, "info" | "warn">;
  maxTokens?: number;
  /**
   * LLMへ渡すユーザーメッセージ。省略時は初回の定型指示({@link lessonInstruction})。
   *
   * 2回目以降の往復では「ここまでのやりとり + 続きだけを返す」の指示
   * (`senpai.ts` の `lessonContinuationInstruction`)が入る。systemは毎回同じ正本で、
   * **何が起きたかはユーザーメッセージ側に載せる** — systemを合成し直す作りにすると、
   * どの文が正本でどの文が実行時の産物か、パスを重ねるほど分からなくなる。
   */
  instruction?: string;
  /** 検証済みの手順を、板書と音声へ出す前に抑止する条件。 */
  stopBefore?: (step: BoardStep) => boolean;
  /**
   * LLMのチャンク列を包む層。**先読み合成の差し込み口**で、既定は素通し。
   *
   * `speak` が読み上げ終わりまで待つ間、配送はチャンクを読まない。その裏で
   * 先へ読み進めて次の手順の文を取り出すのが `speech-prefetch.ts` の仕事で、
   * ここはその層を挟むためだけの穴。**LiveKitの型はここへ持ち込まない**
   * (この層が実鍵なしでテストできることを保つ)。
   *
   * 作り直し({@link StepRepair})の呼び出しには掛けない — あれが返すのは
   * 手順1つで、板書レッスンの形をしていないため。
   */
  wrapChunks?: (chunks: AsyncIterable<string>) => AsyncIterable<string>;
};

export type BoardLessonResult = BoardAppendResult & {
  /** **実際にワイヤーへ出した**手順。教え返しのプロンプトに渡す材料。 */
  steps: BoardStep[];
};

/**
 * 板書レッスンを1回ぶん流す。
 *
 * 手順が閉じた端から `board_step` を送り、**送信の直後に**読み上げる(§3-2)。
 * 逆にすると「ここ、見て」が空の盤面を指す。
 *
 * 板書は**閉じない**。寿命は1つの問題で、教え返しの間も画面に残る
 * (閉じるのは `agent.ts` がセッションを終えるとき)。
 */
export async function runBoardLesson(options: RunBoardLessonOptions): Promise<BoardLessonResult> {
  const {
    llm,
    system,
    systemTail,
    locale,
    delivery,
    speak,
    signal,
    log,
    maxTokens = boardLessonMaxTokens,
    instruction,
    stopBefore,
    wrapChunks,
  } = options;

  const steps: BoardStep[] = [];

  const chunks = llm.stream({
    system,
    systemTail,
    user: instruction ?? lessonInstruction[locale],
    maxTokens,
    signal,
  });

  const result = await delivery.append({
    chunks: wrapChunks === undefined ? chunks : wrapChunks(chunks),
    signal,
    stopBefore,
    onStep: async (step) => {
      steps.push(step);
      // 割り込み後は喋らない。板書はもう出ているので消さないが、
      // 生徒が話し始めた上に音声を重ねる理由はない。
      if (signal?.aborted === true) return;
      await speak(step);
    },
    // **問いかけたら、そこで止めて答えを待つ。**プロンプト側の「質問を出したら
    // その板書はそこで終える」を、生成のぶれに任せずここで守る
    // (`board.ts` の `stopAfter` にその判断を置かない理由も同じコメントにある)。
    //
    // 通常の問いは `awaits_student`、類題は `awaits_solving` が一次情報。
    // 前者だけ、欄が無いときに言い回しの推測へ落ちる。どちらで止まったかはログに残す —
    // フォールバックで止まる授業が多いなら、プロンプトが欄を書けていない。
    stopAfter: (step) => {
      const stops = stepAwaitsInput(step, locale);
      if (stops) {
        log?.info("board_turn_awaited", {
          index: step.index,
          basis: stepAwaitsSolving(step)
            ? "solving"
            : step.awaits_student === undefined
              ? "fallback"
              : "field",
        });
      }
      return stops;
    },
    repair: (rejection) => repairStep({ llm, system, locale, rejection, signal, log }),
    repairHead: (rejection) =>
      askForJson({
        llm,
        system,
        user: headRepairInstruction[locale](rejection),
        signal,
        log,
        what: "board_head_repair",
        index: 0,
      }),
  });

  return { ...result, steps };
}

/**
 * 落ちた手順1つを作り直させる。直らなければ `null`(そこで説明は打ち切られる)。
 *
 * ここでの待ちは**そのまま音声の空白になる**(`board.ts` の設計判断の2)。
 * だから `maxTokens` は手順1つぶんに絞ってあり、既定の再試行回数も1回のまま。
 */
async function repairStep(input: {
  llm: LessonLlm;
  system: string;
  locale: CurriculumLocale;
  rejection: BoardStepRejection;
  signal?: AbortSignal;
  log?: Pick<JobLogger, "info" | "warn">;
}): Promise<unknown> {
  const { llm, system, locale, rejection, signal, log } = input;
  return askForJson({
    llm,
    system,
    user: repairInstruction[locale](rejection),
    signal,
    log,
    what: "board_step_repair",
    index: rejection.index,
    reason: rejection.reason,
  });
}

/**
 * 作り直しをLLMに頼んで、JSONを1つ取り出す。手順と見出しで共通の口。
 *
 * 落ちたときは `null`。**粘らない** — 直らなかったのは指示が効かない書き方を
 * しているということで、同じ指示をもう一度渡しても同じ失敗の族に落ちる。
 */
async function askForJson(input: {
  llm: LessonLlm;
  system: string;
  user: string;
  signal?: AbortSignal;
  log?: Pick<JobLogger, "info" | "warn">;
  /** ログの見出しの接頭辞(`board_step_repair` / `board_head_repair`)。 */
  what: string;
  index: number;
  reason?: string;
}): Promise<unknown> {
  const { llm, system, user, signal, log, what, index, reason } = input;

  let raw = "";
  try {
    for await (const chunk of llm.stream({
      system,
      user,
      maxTokens: boardRepairMaxTokens,
      signal,
    })) {
      raw += chunk;
    }
  } catch (error) {
    log?.warn(`${what}_failed`, {
      index,
      ...(reason === undefined ? {} : { reason }),
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  try {
    return extractJson(raw);
  } catch {
    log?.warn(`${what}_unreadable`, {
      index,
      ...(reason === undefined ? {} : { reason }),
    });
    return null;
  }
}

/**
 * セッションの終わり方を、板書の締め方に翻訳する。
 *
 * `timeout` を `completed` に寄せるのは、**上限時間はサーバが決めた予定どおりの
 * 終わり方**だから。板書の `reason` は受信側が「途中で壊れたのか」を見るための札で、
 * ここに `error` を入れると、正常に15分使い切ったセッションが全部エラー扱いになる。
 */
export function boardCloseReasonFor(
  reason: CompleteSessionRequest["ended_reason"],
): BoardCloseReason {
  switch (reason) {
    // **「わかった」は `completed`。**押した瞬間に板書が `error` で閉じると、
    // 生徒の画面には「とちゅうで壊れた板書」として残る — いま理解したものが、
    // 事故の記録に見える(#174 の確かめること)。
    case "understood":
    case "completed":
    case "timeout":
      return "completed";
    case "user_left":
      return "interrupted";
    default:
      return "error";
  }
}
