/**
 * 板書の受信箱・`plot.fn` の評価器・トークンの metadata 読み出し。
 *
 * この3つだけをテストするのは、**web と実機で答えが違ってはいけない**のがここだからで、
 * 画面の見た目(道具としての体裁)は対象にしない。欠落の扱いが実機とずれると、
 * チューニング中に「web では出るのに実機では出ない板書」を追いかけることになる。
 */
import { describe, expect, it } from "vitest";
import { decodeTokenMetadata } from "../public/api.js";
import { BoardInbox } from "../public/board.js";
import { parsePlotExpression } from "../public/plot.js";

const SESSION = "ses_test";

const open = (seq, boardId = "brd_1") => ({
  v: 1,
  session_id: SESSION,
  board_id: boardId,
  seq,
  type: "board_open",
  title: "判別式",
  topic_ids: ["jp.math.hs.i.quadratic_discriminant"],
});

const step = (seq, index, boardId = "brd_1") => ({
  v: 1,
  session_id: SESSION,
  board_id: boardId,
  seq,
  type: "board_step",
  step: {
    index,
    speech: "ここ、見てほしいんだけど。",
    board: { kind: "text", body: "D = b^2-4ac" },
  },
});

const close = (seq, stepCount, boardId = "brd_1") => ({
  v: 1,
  session_id: SESSION,
  board_id: boardId,
  seq,
  type: "board_close",
  step_count: stepCount,
  reason: "completed",
});

describe("BoardInbox", () => {
  it("open → step → close を順に積む", () => {
    const inbox = new BoardInbox(SESSION);
    expect(inbox.accept(open(0))).toBe(true);
    expect(inbox.accept(step(1, 0))).toBe(true);
    expect(inbox.accept(step(2, 1))).toBe(true);
    expect(inbox.accept(close(3, 2))).toBe(true);

    expect(inbox.title).toBe("判別式");
    expect(inbox.steps).toHaveLength(2);
    expect(inbox.gapReason).toBeNull();
    expect(inbox.closedReason).toBe("completed");
  });

  it("seq が飛んだら、積んだ行は残したまま、そこから先は積まない", () => {
    const inbox = new BoardInbox(SESSION);
    inbox.accept(open(0));
    inbox.accept(step(1, 0));

    expect(inbox.accept(step(3, 1))).toBe(true);
    expect(inbox.gapReason).toContain("seq");
    expect(inbox.steps).toHaveLength(1);

    // とぎれた板書には積まない(復帰点は board_open だけ)。
    expect(inbox.accept(step(4, 1))).toBe(false);
    expect(inbox.steps).toHaveLength(1);
  });

  it("次の board_open で復帰し、そこから seq を数え直す", () => {
    const inbox = new BoardInbox(SESSION);
    inbox.accept(open(0));
    inbox.accept(step(2, 0));
    expect(inbox.gapReason).not.toBeNull();

    expect(inbox.accept(open(7, "brd_2"))).toBe(true);
    expect(inbox.gapReason).toBeNull();
    expect(inbox.steps).toHaveLength(0);

    expect(inbox.accept(step(8, 0, "brd_2"))).toBe(true);
    expect(inbox.steps).toHaveLength(1);
    // 復帰後の欠落もひきつづき検知できること。
    expect(inbox.accept(step(10, 1, "brd_2"))).toBe(true);
    expect(inbox.gapReason).toContain("seq");
  });

  it("宛先違い・index の飛び・step_count の食い違いをそれぞれ検知する", () => {
    const other = new BoardInbox(SESSION);
    other.accept({ ...open(0), session_id: "ses_other" });
    expect(other.gapReason).toContain("別のセッション");

    const skipped = new BoardInbox(SESSION);
    skipped.accept(open(0));
    skipped.accept(step(1, 1));
    expect(skipped.gapReason).toContain("index");

    const miscounted = new BoardInbox(SESSION);
    miscounted.accept(open(0));
    miscounted.accept(step(1, 0));
    miscounted.accept(close(2, 5));
    expect(miscounted.gapReason).toContain("step_count");
  });

  it("読めない封筒は欠落として扱う(黙って捨てない)", () => {
    const inbox = new BoardInbox(SESSION);
    expect(inbox.acceptPayload("{ちぎれた")).toBe(true);
    expect(inbox.gapReason).toContain("封筒を読めませんでした");
  });
});

describe("parsePlotExpression", () => {
  it("四則と累乗を、優先順位どおりに評価する", () => {
    expect(parsePlotExpression("x^2 - 3*x + 2")(4)).toBe(6);
    expect(parsePlotExpression("2^3^2")(0)).toBe(512);
    expect(parsePlotExpression("-x^2")(3)).toBe(-9);
    expect(parsePlotExpression("(x + 1)/2")(5)).toBe(3);
  });

  it("契約が許す関数名と pi を解釈する(log は底10、ln は自然対数)", () => {
    expect(parsePlotExpression("log(100)")(0)).toBeCloseTo(2);
    expect(parsePlotExpression("ln(exp(1))")(0)).toBeCloseTo(1);
    expect(parsePlotExpression("sin(pi/2)")(0)).toBeCloseTo(1);
    expect(parsePlotExpression("sqrt(abs(x))")(-9)).toBe(3);
  });

  it("文法の外は投げる(描画側があきらめられるように)", () => {
    expect(() => parsePlotExpression("y + 1")).toThrow();
    expect(() => parsePlotExpression("2x")).toThrow();
    expect(() => parsePlotExpression("x +")).toThrow();
  });
});

describe("decodeTokenMetadata", () => {
  /** LiveKitのトークンと同じ形(header.payload.signature)を組み立てる。 */
  const tokenWith = (claims) => {
    const payload = Buffer.from(JSON.stringify(claims), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `header.${payload}.signature`;
  };

  it("agent に渡した会話文脈を、日本語のまま読み出す", () => {
    const metadata = { session_id: "ses_1", problem_text: "2次方程式 x²-3x+2=0 を解け" };
    const decoded = decodeTokenMetadata(tokenWith({ metadata: JSON.stringify(metadata) }));

    // atob はバイト列を返すだけなので、UTF-8として解釈し直さないと文字化けする。
    expect(decoded.metadata).toEqual(metadata);
  });

  it("metadata が無いトークンでも落ちない", () => {
    expect(decodeTokenMetadata(tokenWith({ sub: "student" })).metadata).toBeNull();
    expect(decodeTokenMetadata("これはトークンではない")).toBeNull();
  });
});
