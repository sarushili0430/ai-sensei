import { z } from "zod";
import { topicIdSchema } from "./karte.ts";

/**
 * 板書(先輩が画面に積んでいく行)の契約。
 *
 * 設計上の約束(ピボット計画 v1 §3-1 が根拠。破る実装は却下される):
 *   - **数式・計算・図は板書、音声は問いかけと接続だけ。** これは見た目の話ではなく
 *     原価の主柱で、TTS文字数がそのまま請求額になる。だから「短く喋る」を
 *     プロンプトのお願いではなく **スキーマの上限** で守る({@link boardSpeechMaxLength})。
 *   - **自由描画をさせない。** 図形はプリミティブを4種(latex / text / plot / triangle / circle)に
 *     固定し、LLMにはパラメータだけ吐かせる。SVGもcanvasコマンドも受け取らない。
 *   - **解答を丸ごと1要素に流し込めない。** 板書は「1手順=1行」であって答案の貼り付け場所ではない。
 *     `tex` / `body` の上限と、**1回の出力あたりの**手順数の上限
 *     ({@link boardLessonStepsMaxCount})の両方で縛る。
 *   - **座標は有限で、盤面に収まる範囲。** `Infinity` や 1e300 が来ると Flutter 側が黙って壊れる。
 *
 * このファイルは2つの形を持つ。責務が違うので **意図的に分けている**:
 *
 *   1. **LLMが出す形**({@link boardLessonSchema})
 *      agent が構造化出力で受け取る、**1回の説明ぶん**。ストリーミングJSONを
 *      インクリメンタルにパースし、`steps[i]` が閉じた時点で {@link boardStepSchema} で1手順だけ検証する。
 *      LLMは「どの部屋の、何番目のメッセージか」を知らないし、知らせる必要もない。
 *      セッションの識別子をLLMの出力に混ぜると、幻覚したIDが配送層に流れ込む。
 *      **何回目の説明かも知らせない。**通し番号を持たせると、幻覚した番号がワイヤーに出る。
 *
 *   2. **data channel を流れる形**({@link boardChannelMessageSchema})
 *      LiveKit の data channel で1手順ずつモバイルへ送る封筒。
 *      宛先(session_id)・どの板書か(board_id)・順序(seq / index)を持つ。
 *      配送の都合(順序保証・欠落検知・板書の切り替え)は **全部こちら側の責務**で、
 *      LLMの出力形式には一切漏らさない。
 *
 * 同期はミリ秒ではなく **手順の粒度** で取る(§3-2)。フロントは受信順に1行ずつ積み、
 * 前の行は消さない。消えるのは {@link boardOpenMessageSchema} が来たとき(= 別の問題に移るとき)だけ。
 */

/**
 * `speech` の上限。**日本語TTSの発話速度 約330字/分から逆算している。**
 *
 *   120字 ÷ 330字/分 ≒ 22秒 → 1手順あたり20〜25秒。
 *
 * 「音声は問いかけと接続だけ」(§3-1)を、プロンプトの言葉づかいではなくスキーマで守るための値。
 * ここを緩めるとTTS原価が線形に増え、月5,000円の粗利(§6-2)が消える。
 * 数式を読み上げ始めた瞬間に120字は必ず超えるので、**上限そのものが原則の検査になっている。**
 */
export const boardSpeechMaxLength = 120;

/**
 * `latex` の上限。板書の1行として画面幅に収まる長さ。
 * `x^2 - 3x + 2 = 0 \Rightarrow D = 9 - 8 = 1 > 0` で約45字なので、200字は「1行としては長すぎる」
 * ものだけを弾く緩めの線。答案の貼り付けを止めるのは、この上限と
 * {@link boardLessonStepsMaxCount} と多行環境の禁止(下記)の3つで行う。
 */
export const boardTexMaxLength = 200;

/** `text` の上限。板書に添える見出し・注記の1行(「a = 1, b = -3, c = 2」など)。 */
export const boardTextMaxLength = 100;

/** ラベル(頂点名・目盛の注記)の上限。1〜2語で足りる。 */
export const boardLabelMaxLength = 24;

/**
 * **LLMが1回に出せる手順数の上限**({@link boardLessonSchema} の `steps`)。
 *
 * 判別式のような単元は6〜8手順で終わる。上限がないと、LLMは
 * 「1行ずつだが40行」という形で解答を丸ごと流し込める(1要素の上限をすり抜ける抜け道)。
 * **1回の説明でこれを超えるなら、それは板書ではなく答案。**
 *
 * これは**板書1枚の上限ではない**({@link boardStepsMaxCount})。
 * 板書は1つの問題ぶん生き続け、何回かの説明が同じ板書に積み上がる。
 */
export const boardLessonStepsMaxCount = 12;

/**
 * **板書1枚に積める手順数の上限**。ワイヤーの `index`({@link boardStepSchema})と
 * {@link boardCloseMessageSchema} の `step_count` の上限。
 *
 * 板書の寿命は「1回の説明」ではなく **「1つの問題」**(§3-2「前の行は消さない。
 * 消えるのは別の問題に移るときだけ」)。1回のLLM呼び出しごとに板書を開き直すと、
 * **会話が1往復するたびに板書が消える** — 板書の価値そのものが失われる。
 *
 * 1つの問題は15〜20分(§4-1)で、その間に説明は何往復かする:
 *
 *   切り分け2〜3手順 + 教える5〜8手順 + 教え返しへの受け渡し1手順 ≒ **1往復 8〜12手順**
 *   教え返しで詰まればもう一度教える(§2 のコアループ)ので **2〜3往復**
 *   → **16〜36手順**
 *
 * **40** はその上限側(36)にわずかな余白を足した値。ここに達するのは
 * 「1つの問題に40行書いてまだ終わっていない」ときで、それは板書の不足ではなく
 * 授業の設計の問題(§3-4 のゲートで見る種類の壊れ方)。
 * つまりこの数字は**打ち切りの安全弁**であって、目標値でも推奨値でもない。
 */
export const boardStepsMaxCount = 40;

/**
 * 盤面座標の絶対値の上限。板書は「その場でノートに描く図」なので、
 * 天文学的な座標が要る場面はない。有限性だけでなく大きさも縛る。
 */
export const boardCoordinateLimit = 1000;

/** 盤面の座標値。有限かつ盤面内。 */
const coordinateSchema = z.number().finite().min(-boardCoordinateLimit).max(boardCoordinateLimit);

/**
 * 盤面上の点。
 *
 * 計画書の草案では `Pt` をタプルで書いていたが、`{x, y}` のオブジェクトにした。
 * このファイルは **「異種の値の組はオブジェクト、同種の値の固定長列は配列」** で統一している:
 *
 *   - `{x, y}` / `{min, max}` は中身の意味が違う。位置で区別させると
 *     LLMが入れ違えても検証を素通りしてしまう(`domain: [4, -1]` は形としては正しい)。
 *     **名前を付けた瞬間、取り違えが検出可能になる。**
 *   - `vertices` の3点や `labels` の3つは同種で、順序は「1番目の頂点」以上の意味を持たない。
 *     配列(`z.tuple`)のままにしてある。JSON Schema には `minItems`/`maxItems` として残るので、
 *     Dart側は `List<BoardPoint>` + 長さ3の検査で足り、参照からその条件が読み取れる。
 */
export const boardPointSchema = z.object({ x: coordinateSchema, y: coordinateSchema }).strict();
export type BoardPoint = z.infer<typeof boardPointSchema>;

/** 板書に積む要素の種類。増やすときは Flutter 側の描画実装とセットで増やす。 */
export const boardElementKinds = ["latex", "text", "plot", "triangle", "circle"] as const;
export type BoardElementKind = (typeof boardElementKinds)[number];

/**
 * 多行のLaTeX環境を含まないこと。`\begin{align}` を許すと「1手順=1行」が崩れ、
 * 答案を1要素に流し込む抜け道になるので **スキーマで禁止する**。
 *
 * `cases`(場合分け)と `matrix` 系は意図的に禁止リストに入れていない = 使ってよい。
 * 場合分けは高校数学で1行として自然に読める板書だから
 * (計画書 §3-6 の実測ホワイトリストでも `\begin{pmatrix}` `\begin{cases}` は許可されている)。
 *
 * **ここで見るのは「1行かどうか」という構造だけ。** そのコマンドを
 * `flutter_math_fork` が描けるかどうか(コマンドのホワイトリスト・KaTeXでの実パース)は
 * `packages/guardrail` と agent の責務(計画書 §3-6 の三段構え)。
 * contract は依存を持たない層なので、中身の照合には踏み込まない
 * (`karte.ts` の `topicIdSchema` と同じ分担)。
 *
 * **`.refine()` ではなく `.regex()` で書く。** refineはJSON Schemaに残らず、
 * `schema/*.json` を唯一の参照にするDart実装者からこの制約が見えなくなる
 * (README「JSON Schema に現れない不変条件」を参照)。否定先読み + `[\s\S]` にしてあるのは、
 * `pattern` にはフラグが載らないため。`.` + `s` フラグだと改行入りの `tex` をすり抜ける。
 */
const noMultilineLatexPattern =
  /^(?![\s\S]*\\begin\{(?:align|gather|eqnarray|array|split|multline)\*?\})[\s\S]*$/;

export const latexElementSchema = z
  .object({
    kind: z.literal("latex"),
    /**
     * flutter_math_fork が描く数式。1行ぶん。
     *
     * **文字数の上限は表示幅を保証しない**(`\frac` は縦に伸びるだけ、`\sum_{k=1}^{n}` は
     * 短いのに幅を食う)。実機幅340pt に長い式が収まらない問題は計画書 §3-6b の未解決事項で、
     * 実測後にここの縛り方が変わる可能性がある。
     */
    tex: z.string().min(1).max(boardTexMaxLength).regex(noMultilineLatexPattern, {
      message: "板書は1手順=1行。多行環境(align/gather/array...)は使えません",
    }),
  })
  .strict();

export const textElementSchema = z
  .object({
    kind: z.literal("text"),
    /** 数式にしない一行。見出し・注記・言い換え。解説文の置き場ではない。 */
    body: z.string().min(1).max(boardTextMaxLength),
  })
  .strict();

/**
 * グラフに打つ印。交点・頂点など「見てほしい一点」だけ。
 * 上限4個。印が5個以上要る図は、板書ではなく資料になっている。
 */
export const plotMarkSchema = z
  .object({
    at: boardPointSchema,
    label: z.string().min(1).max(boardLabelMaxLength).optional(),
  })
  .strict();
export type PlotMark = z.infer<typeof plotMarkSchema>;

/**
 * `fn` に許す形。**端末上で式を評価するので、入力の形をここで閉じる。**
 * 許すのは 変数x / 数字 / 四則 / 累乗 / 括弧 と、列挙した関数名だけ。
 * 「LLMにはパラメータだけ吐かせる」(§3-3)を関数式にも適用したもの。
 *
 * 関数名と文字種を **1本の正規表現** にしてあるのは、`.refine()` の2段検査だと
 * JSON Schema に何も残らないため({@link noMultilineLatexPattern} と同じ理由)。
 * 許可文字にアルファベットは `x` しか無く、どの関数名も `x` 以外の文字を含むので、
 * 各位置で選べる枝は高々1つ = **バックトラックしない**。
 * ここに `e`(ネイピア数)を足すと `exp` の解釈が2通りになり、失敗する入力で
 * 指数的なバックトラックが起きる(zodは `.max()` で打ち切らずに正規表現も評価する)。
 * なので `e^x` は書けない。**`exp(x)` と書かせること**(プロンプト側の約束)。
 */
const plotFunctionPattern = /^(?:sin|cos|tan|sqrt|abs|log|ln|exp|pi|[-+*/^().,0-9x\s])+$/;

export const plotElementSchema = z
  .object({
    kind: z.literal("plot"),
    /** xの式。例 `x^2 - 3*x + 2`。掛け算の `*` は省略させない(パーサ差で崩れるため)。 */
    fn: z.string().min(1).max(80).regex(plotFunctionPattern, {
      message: "fn には x・数値・四則・^・括弧と、既定の関数名しか使えません",
    }),
    /**
     * 描画するxの範囲。草案の `[number, number]` から `{min, max}` に変えた
     * (理由は {@link boardPointSchema})。
     *
     * `min < max` は **JSON Schema に書けない**({@link boardChannelLogSchema} の順序規約と同じ)。
     * Dart側は手で入れる必要がある。README の「JSON Schema に現れない不変条件」に一覧がある。
     */
    domain: z
      .object({ min: coordinateSchema, max: coordinateSchema })
      .strict()
      .refine((domain) => domain.min < domain.max, {
        message: "domain は min < max",
        path: ["max"],
      }),
    marks: z.array(plotMarkSchema).max(4).optional(),
  })
  .strict();

/**
 * 三角形の角の印。`vertex` は `vertices` のインデックス(0〜2)。
 * 頂点名ではなくインデックスで指すのは、ラベルが無い三角形でも印を打てるようにするため。
 */
export const angleMarkSchema = z
  .object({
    vertex: z.number().int().min(0).max(2),
    kind: z.enum(["angle", "right_angle"]),
    label: z.string().min(1).max(boardLabelMaxLength).optional(),
  })
  .strict();
export type AngleMark = z.infer<typeof angleMarkSchema>;

export const triangleElementSchema = z
  .object({
    kind: z.literal("triangle"),
    vertices: z.tuple([boardPointSchema, boardPointSchema, boardPointSchema]),
    /** 頂点名。付けるなら3つ揃える(A・Bだけ付いた三角形は板書として読めない)。 */
    labels: z
      .tuple([
        z.string().min(1).max(boardLabelMaxLength),
        z.string().min(1).max(boardLabelMaxLength),
        z.string().min(1).max(boardLabelMaxLength),
      ])
      .optional(),
    marks: z.array(angleMarkSchema).max(3).optional(),
  })
  .strict();

export const circleElementSchema = z
  .object({
    kind: z.literal("circle"),
    center: boardPointSchema,
    /** 半径。0は円にならないので受け付けない。 */
    r: z.number().finite().positive().max(boardCoordinateLimit),
    /** 中心名・半径の注記など。最大3つ。 */
    labels: z.array(z.string().min(1).max(boardLabelMaxLength)).max(3).optional(),
  })
  .strict();

/**
 * 板書に積む1要素。`kind` の discriminated union。
 * 自由描画(SVG・パス・任意テキストの塊)は **どの枝にも存在しない**。
 */
export const boardElementSchema = z.discriminatedUnion("kind", [
  latexElementSchema,
  textElementSchema,
  plotElementSchema,
  triangleElementSchema,
  circleElementSchema,
]);
export type BoardElement = z.infer<typeof boardElementSchema>;

/**
 * LaTeXコマンド(`\` + 英字)を含まないこと。`speech` に使う。
 * 理由と書き方は {@link noMultilineLatexPattern} と同じ(`.refine()` はJSON Schemaに残らない)。
 */
const noLatexCommandPattern = /^(?![\s\S]*\\[a-zA-Z])[\s\S]*$/;

/**
 * 手順1つ = 「先輩がひとこと言いながら、板書を1行足す」単位。同期の粒度でもある。
 *
 * `speech` は必ず1文字以上ある。板書だけが無言で増える手順を許さないのは、
 * (a) ユーザーが割り込む隙が消える (b) フロントが「次に何を待てばいいか」を失う
 * の2点による。無言で書きたい場面は「じゃあ、ここ。」のような短い接続で足りる。
 */
export const boardStepSchema = z
  .object({
    /**
     * 板書内での通し番号。**0始まり**で、1ずつ増える(欠落検知の二重化)。
     *
     * このスキーマは2つの文脈で使われ、**`index` が数える範囲が違う**:
     *
     *   - {@link boardLessonSchema} の中(LLMが出す形)= **その1回の出力の中で0始まり**。
     *     LLMは自分が何回目の呼び出しかを知らないし、知らせない
     *     (通し番号を持たせると、幻覚した番号がワイヤーに出る)。
     *   - {@link boardStepMessageSchema} の中(ワイヤー)= **板書1枚の中で0始まり**。
     *     板書は1つの問題ぶん生き続けるので、2回目以降の説明は前の続きの番号になる。
     *     **付け直すのは配送層の責務。**
     *
     * したがって上限は広いほう({@link boardStepsMaxCount})で取る。
     * LLM出力側がこれより厳しいことは、`steps` の要素数
     * ({@link boardLessonStepsMaxCount})と `index === position` の検査で担保される。
     */
    index: z
      .number()
      .int()
      .min(0)
      .max(boardStepsMaxCount - 1),
    /**
     * 読み上げる文。問いかけと接続だけ(§3-1)。
     * LaTeXコマンドが混ざっていたら、それは板書に置くべきものを喋らせている。
     * `$` は英語の文章題で通貨として出るので見ない。見るのは `\` + 英字だけ。
     */
    speech: z.string().min(1).max(boardSpeechMaxLength).regex(noLatexCommandPattern, {
      message: "speech に数式(LaTeX)を入れないでください。数式は board に置きます",
    }),
    /** 板書に積む要素。**null なら音声のみ**(相づち・確認)。 */
    board: boardElementSchema.nullable(),
  })
  .strict();
export type BoardStep = z.infer<typeof boardStepSchema>;

/**
 * LLMが出す形 — **1回の説明ぶん**。
 *
 * agent はこれをストリーミングJSONで受け取り、`steps[i]` が閉じた時点で
 * {@link boardStepSchema} で1手順だけ検証して即座に配送する(全部揃うのを待たない・§3-2 案A)。
 * したがって **このスキーマ全体での検証は「最後の答え合わせ」** であって、配送のゲートではない。
 *
 * **「1枚の板書」ではないことに注意。**板書(`board_id`)は1つの問題ぶん生き続け、
 * この形の出力が何回か積み上がってできる。`title` / `topic_ids` を毎回持つのは、
 * LLMが「何回目か」を知らないから — **使われるのは最初の1回だけ**で、
 * 2回目以降は配送層が捨てる(そこで `board_open` を出し直すと板書が消える)。
 *
 * session_id / board_id を持たないのは意図。識別子は配送層(封筒)が付ける。
 */
export const boardLessonSchema = z
  .object({
    /** 板書の見出し。画面上部に出す。「この板書は何の問題か」だけ。 */
    title: z.string().min(1).max(60),
    /** 扱っている単元。@ai-sensei/guardrail の範囲チェックに渡す。 */
    topic_ids: z.array(topicIdSchema).min(1).max(3),
    steps: z.array(boardStepSchema).min(1).max(boardLessonStepsMaxCount),
  })
  .strict()
  .superRefine((lesson, ctx) => {
    // index が飛ぶ・重複すると、モバイル側は「まだ来ていない手順」と区別できない。
    lesson.steps.forEach((step, position) => {
      if (step.index !== position) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `index は0始まりで1ずつ増やしてください(${position}番目が index=${step.index})`,
          path: ["steps", position, "index"],
        });
      }
    });
  });
export type BoardLesson = z.infer<typeof boardLessonSchema>;

/* -------------------------------------------------------------------------- */
/* data channel(封筒)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * LiveKit の topic。モバイルはこのtopicだけを板書として読む。
 * 会話用の他のメッセージと同じ経路に混ぜないための札。
 *
 * 経路は **Text Streams API**(`registerTextStreamHandler` + このtopic)で、
 * 生の `publishData` は使わない — 既定が LOSSY で書き忘れると欠落する(計画書 §3-5)。
 * **封筒1つ = 1ストリーム**とし、受信側は `readAll()` で完成を待つ。
 * だから受信側で部分JSONを組み立てる必要はなく、下のスキーマは常に完成したJSONに当たる。
 */
export const boardChannelTopic = "board";

/**
 * 封筒のバージョン。**上げたら旧クライアントは読めない**ので、
 * 旧アプリが残っている間は agent が両方を送るか、送り分ける必要がある。
 * 番号を封筒に入れておくのは、その判断を後から取れるようにするため。
 */
export const boardProtocolVersion = 1;

/**
 * すべての封筒が持つ共通部分。
 *
 * - `session_id`: 宛先の確認。部屋を取り違えた配送を受信側で落とせる。
 * - `board_id`: **1セッション中に複数の問題を扱いうる**ので、手順は必ずどれかの板書に属する。
 * - `seq`: セッション内の通し番号(0始まり・種別をまたいで1ずつ増える)。
 *   **トランスポートの保証を当てにしない検算**。Text Streams は reliable 固定で、
 *   順序・重複排除・再接続時の再送まで面倒を見る(計画書 §3-5)。
 *   それでも `seq` を持つのは、落ちる原因が回線とは限らないから — agent の送信漏れ・
 *   二重送信・ハンドラの取りこぼしは、どれもトランスポートからは正常に見える。
 *   `seq` が飛んだら、モバイルは「板書が抜けている」ことを **描画する前に** 知れる。
 *   手順の `index` だけでは、板書の切り替え信号が落ちたことを検知できない。
 */
const envelopeFields = {
  v: z.literal(boardProtocolVersion),
  session_id: z.string().min(1),
  board_id: z.string().min(1),
  seq: z.number().int().min(0),
};

/**
 * 板書を始める(= 前の板書を消す)信号。
 *
 * 「消す」を独立した信号にした理由: 前の行を消さずに積むのが原則(§3-2)なので、
 * **消えてよい瞬間はただ一つ「別の問題に移るとき」** に限る。
 * これを手順のフラグ(`clear: true` のような)にすると、LLMの気まぐれで
 * 板書が消える経路ができてしまう。板書の切り替えは配送層の判断であって、
 * 授業の内容ではない。
 *
 * **「別の問題に移るとき」であって「次に説明するとき」ではない。**
 * 1つの問題は何往復かの説明でできている(切り分け → 教える → 教え返させる)。
 * LLMを呼ぶたびにこれを送ると、**会話が1往復するたびに板書が消える**。
 * だから `board_open` は1つの問題につき1回で、以降の説明は同じ `board_id` に積む。
 */
export const boardOpenMessageSchema = z
  .object({
    ...envelopeFields,
    type: z.literal("board_open"),
    title: z.string().min(1).max(60),
    topic_ids: z.array(topicIdSchema).min(1).max(3),
  })
  .strict();

/** 手順を1つ積む。data channel を流れる本体はこれ。 */
export const boardStepMessageSchema = z
  .object({
    ...envelopeFields,
    type: z.literal("board_step"),
    step: boardStepSchema,
  })
  .strict();

/**
 * 板書を締める信号。
 *
 * `step_count` を載せるのは **末尾の欠落を検知するため**。`seq` は「途中が抜けた」ことは
 * 教えてくれるが、最後の手順が落ちて配信が止まった場合は「まだ来ていないだけ」と
 * 区別できない。締めの宣言に本数を書いておくと、そこで突き合わせられる。
 */
export const boardCloseMessageSchema = z
  .object({
    ...envelopeFields,
    type: z.literal("board_close"),
    /** **板書1枚ぶんの合計**(1回の説明ぶんではない)。 */
    step_count: z.number().int().min(0).max(boardStepsMaxCount),
    /**
     * `interrupted` はユーザーが割り込んで途中で止めた場合(§3-2 案Aの利点そのもの)。
     * 板書は途中まで残す。エラーとは扱いが違うので、理由をenumで分けておく。
     *
     * **1回の説明が割り込まれただけでは、ここには来ない。**割り込みのあと
     * 同じ問題の説明が続くなら板書は開いたままで、閉じるのは問題そのものが
     * 終わったとき(または終われなかったとき)。
     */
    reason: z.enum(["completed", "interrupted", "error"]),
  })
  .strict();

/** data channel を1件ずつ流れるメッセージ。ワイヤー上に現れるのはこの形だけ。 */
export const boardChannelMessageSchema = z.discriminatedUnion("type", [
  boardOpenMessageSchema,
  boardStepMessageSchema,
  boardCloseMessageSchema,
]);
export type BoardChannelMessage = z.infer<typeof boardChannelMessageSchema>;

/**
 * 1セッションぶんの配送ログ。
 *
 * **ワイヤー上には現れない。**data channel を流れるのは常に1件ずつ
 * ({@link boardChannelMessageSchema})で、これは fixture とゴールデンテストのための入れ物。
 * それでもスキーマとして書くのは、**順序の規約をコメントではなく検査可能な形で残す**ため:
 *
 *   - `seq` は0始まりで1ずつ増える(欠落・重複の検知)
 *   - 手順は必ず `board_open` と `board_close` の間にある
 *   - `index` は板書ごとに0始まりで1ずつ増える
 *   - `board_close.step_count` は実際に送った手順数と一致する
 *
 * agent の配送実装とモバイルの受信実装は、どちらもこの列を通ることになる。
 */
export const boardChannelLogSchema = z
  .object({
    messages: z.array(boardChannelMessageSchema).min(1),
  })
  .strict()
  .superRefine(({ messages }, ctx) => {
    const issue = (message: string, position: number) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: ["messages", position],
      });

    const sessionId = messages[0]?.session_id;
    let openBoardId: string | null = null;
    let sentSteps = 0;

    messages.forEach((message, position) => {
      if (message.seq !== position) {
        issue(`seq は0始まりで1ずつ増やしてください(seq=${message.seq})`, position);
      }
      if (message.session_id !== sessionId) {
        issue("1つのログに複数のセッションを混ぜないでください", position);
      }

      if (message.type === "board_open") {
        if (openBoardId !== null) {
          issue(`板書 ${openBoardId} が board_close されていません`, position);
        }
        openBoardId = message.board_id;
        sentSteps = 0;
        return;
      }

      if (message.board_id !== openBoardId) {
        issue("board_open されていない板書のメッセージです", position);
        return;
      }

      if (message.type === "board_step") {
        if (message.step.index !== sentSteps) {
          issue(
            `index は板書ごとに0始まりで1ずつ(${sentSteps} を期待して ${message.step.index})`,
            position,
          );
        }
        sentSteps += 1;
        return;
      }

      if (message.step_count !== sentSteps) {
        issue(`step_count が実際に送った手順数(${sentSteps})と違います`, position);
      }
      openBoardId = null;
    });
  });
export type BoardChannelLog = z.infer<typeof boardChannelLogSchema>;
