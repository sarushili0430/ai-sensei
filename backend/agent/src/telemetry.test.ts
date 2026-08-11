import { describe, expect, it, vi } from "vitest";
import { JobLogger, type LogFields, setDegradationReporter } from "./log.ts";
import {
  DegradationThrottle,
  agentDegradations,
  createDegradationReporter,
  degradationKey,
  isDegradation,
  messageMaxLength,
  scrubFields,
  scrubMessage,
} from "./telemetry.ts";

/**
 * 縮退の監視のテスト。見たいのは3つ:
 *
 *   1. **本文が出ていかないこと**(問題文はR2にすら保存しないと決めたもの)
 *   2. 正常動作の警告で**アラート疲れを起こさない**こと(閉じた集合・間引き)
 *   3. 鍵が無いとき**何もしない**こと(監視の有無でプロダクトの挙動を変えない)
 */

describe("isDegradation", () => {
  // 「生徒に届くはずのものが届かなかったか」だけを入れる
  it("送信側の縮退を拾う", () => {
    expect(isDegradation("board_append_failed")).toBe(true);
    expect(isDegradation("board_step_rejected")).toBe(true);
    expect(isDegradation("lesson_empty")).toBe(true);
    expect(isDegradation("review_hole_missing")).toBe(true);
    expect(isDegradation("plan_template_fallback")).toBe(true);
  });

  /**
   * ここを緩めると**ほぼ全セッションで警告が鳴り、本物の異常が埋もれる**。
   * #12 で `containsAnswerLeak` を捨てたのと同じ失敗の形。
   */
  it("正常動作の警告は縮退にしない", () => {
    // 2回目以降の見出しを捨てるのは仕様どおり(捨てないと板書が消える)
    expect(isDegradation("board_head_ignored")).toBe(false);
    // LLMの数え間違いは配送層が直しているので、届くものは正しい
    expect(isDegradation("board_step_index_overridden")).toBe(false);
    // 割り込みは §3-2 が案Aを採った理由そのもの
    expect(isDegradation("lesson_interrupted_by_user")).toBe(false);
  });

  it("見出しは検索とグルーピングのために英語のまま", () => {
    for (const event of agentDegradations) {
      expect(event, event).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    }
  });
});

describe("scrubFields", () => {
  /**
   * `board_opened` の `title` は**LLMが問題を見て書いた文字列**。
   * 問題文は他者の著作物で、R2にすら保存しないと決めたもの(計画書 §4-1)。
   */
  it("本文の欄は落とす", () => {
    const scrubbed = scrubFields({
      board_id: "brd_1",
      title: "判別式で解の個数を見る",
      detail: "\\text{よって} が使えません",
      message: "手順のJSONが読めません: ...",
    });

    expect(scrubbed).toEqual({ board_id: "brd_1" });
  });

  // deny ではなく allow。欄が増えたときに**既定で送られない**側に倒す
  it("知らない文字列の欄は、既定で落とす", () => {
    expect(scrubFields({ future_field: "何か" })).toEqual({});
  });

  it("数と真偽はそのまま通す(件数・位置・所要時間)", () => {
    expect(scrubFields({ index: 3, step_count: 12, opened: true })).toEqual({
      index: 3,
      step_count: 12,
      opened: true,
    });
  });

  // 配列とオブジェクトは中身が読めないので丸ごと落とす
  it("入れ子は落とす", () => {
    expect(scrubFields({ utterances: ["答えは2点で交わる"], nested: { tex: "x^2" } })).toEqual({});
  });

  it("種類の判別に要る列挙は通す", () => {
    expect(scrubFields({ reason: "text_in_math", session_id: "ses_1" })).toEqual({
      reason: "text_in_math",
      session_id: "ses_1",
    });
  });
});

describe("DegradationThrottle", () => {
  it("同じ鍵は1回だけ通す", () => {
    const throttle = new DegradationThrottle();
    expect(throttle.allow("a")).toBe(true);
    expect(throttle.allow("a")).toBe(false);
    expect(throttle.allow("b")).toBe(true);
  });

  // 無制限に覚えると、長く動いているワーカーでここだけが太り続ける
  it("上限に達したら全部忘れる(送りすぎより黙るほうが困る)", () => {
    const throttle = new DegradationThrottle(2);
    throttle.allow("a");
    throttle.allow("b");
    // ここで忘れるので、a はもう一度だけ通る
    expect(throttle.allow("c")).toBe(true);
    expect(throttle.allow("a")).toBe(true);
  });
});

describe("degradationKey", () => {
  // 1回の授業で何十手順も流れる。板書1枚につき1件送れば、どこで起きたかは分かる
  it("板書がらみは board_id 単位", () => {
    expect(degradationKey("board_step_rejected", { board_id: "brd_1", session_id: "ses_1" })).toBe(
      "board_step_rejected/brd_1",
    );
  });

  it("board_id を持たない縮退はセッション単位", () => {
    expect(degradationKey("board_publisher_missing", { session_id: "ses_1" })).toBe(
      "board_publisher_missing/ses_1",
    );
  });

  it("計画の縮退は計画セッション単位", () => {
    expect(
      degradationKey("plan_template_fallback", { plan_session_id: "pls_1", reason: "shape" }),
    ).toBe("plan_template_fallback/pls_1");
  });
});

describe("createDegradationReporter", () => {
  it("縮退だけを、伏せ字にして1回だけ送る", () => {
    const capture = vi.fn();
    const report = createDegradationReporter(capture);

    report("board_step_rejected", { board_id: "brd_1", index: 2, detail: "描けない式" });
    report("board_step_rejected", { board_id: "brd_1", index: 5, detail: "また描けない式" });
    report("board_head_ignored", { board_id: "brd_1", title: "判別式" });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("board_step_rejected", { board_id: "brd_1", index: 2 });
  });

  it("板書が違えば別の出来事として送る", () => {
    const capture = vi.fn();
    const report = createDegradationReporter(capture);

    report("board_append_failed", { board_id: "brd_1" });
    report("board_append_failed", { board_id: "brd_2" });

    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe("JobLogger と縮退の配線", () => {
  function sink() {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line) };
  }

  /**
   * **鍵が無いときは何もしない。**監視の有無でプロダクトの挙動が変わってはいけない
   * (モバイル側の `SentryConfig.isConfigured` と同じ約束)。
   */
  it("受け皿が無ければ何も起きない", () => {
    setDegradationReporter(null);
    const out = sink();
    const log = new JobLogger({ session_id: "ses_1" }, out.write, out.write);

    expect(() => log.warn("board_append_failed", { board_id: "brd_1" })).not.toThrow();
    expect(out.lines).toHaveLength(1);
  });

  it("warn は標準出力と受け皿の両方に出る", () => {
    const captured: { event: string; fields: LogFields }[] = [];
    setDegradationReporter((event, fields) => captured.push({ event, fields }));

    const out = sink();
    const log = new JobLogger({ session_id: "ses_1" }, out.write, out.write);
    log.warn("board_append_failed", { board_id: "brd_1" });

    // 標準出力には従来どおり全部出る(監視に送る内容とは別)
    expect(JSON.parse(out.lines[0] as string)).toMatchObject({
      level: "warn",
      event: "board_append_failed",
      session_id: "ses_1",
      board_id: "brd_1",
    });
    // 受け皿には `session_id`(base)も一緒に渡る
    expect(captured[0]).toEqual({
      event: "board_append_failed",
      fields: { session_id: "ses_1", board_id: "brd_1" },
    });

    setDegradationReporter(null);
  });

  // クラッシュと縮退を同じ棚に置かない。error は従来どおり ErrorReporter へ
  it("error は縮退の口には流れない", () => {
    const captured: string[] = [];
    setDegradationReporter((event) => captured.push(event));

    const out = sink();
    new JobLogger({}, out.write, out.write).error("karte_failed", new Error("boom"));

    expect(captured).toEqual([]);
    setDegradationReporter(null);
  });
});

describe("scrubMessage", () => {
  /**
   * モバイル側が踏んだ罠のサーバ版。外部SDK(LiveKit / Deepgram / Anthropic)の例外は
   * そのまま `captureException` に載るので、接続先URLやトークンが同じ経路で飛びうる。
   */
  it("URLはスキームとホストまでにする(秘密はパスとクエリに乗る)", () => {
    expect(
      scrubMessage("connect failed: wss://example.livekit.cloud/rtc?access_token=abc.def"),
    ).toBe("connect failed: wss://example.livekit.cloud/…");
  });

  // どのサービスで失敗したかは判断に要るので、ホストは残す
  it("ホストは残す", () => {
    expect(scrubMessage("https://api.anthropic.com/v1/messages で失敗")).toContain(
      "https://api.anthropic.com",
    );
  });

  it("トークンらしい長い塊は潰す", () => {
    // 本物ではなく、伏せ字化を検査するための入力。
    // シークレット走査がこれを拾うのは**正しい挙動**なので、この行だけ許可する。
    const fakeKey = "sk-ant-api03-AAAABBBBCCCCDDDD"; // pragma: allowlist secret
    expect(scrubMessage(`x-api-key ${fakeKey} が拒否されました`)).not.toContain("AAAABBBBCCCCDDDD");
  });

  // 日本語の文と短い数式は巻き添えにしない(読めなくなると意味がない)
  it("ふつうの文はそのまま残る", () => {
    expect(scrubMessage("板書のJSONが長すぎます(64001 > 64000)")).toBe(
      "板書のJSONが長すぎます(64001 > 64000)",
    );
  });

  /**
   * 自前のメッセージにはAPIの応答本文が入る(`lesson.ts` の
   * 「板書の生成に失敗しました: <status> <body>」)。応答本文にはLLMの出力が入りうる。
   */
  it("長すぎるメッセージは切る", () => {
    const long = `板書の生成に失敗しました: 400 ${"あ".repeat(500)}`;
    const scrubbed = scrubMessage(long);
    expect(scrubbed.length).toBeLessThanOrEqual(messageMaxLength + 1);
    expect(scrubbed.endsWith("…")).toBe(true);
  });
});

describe("scrubFields(エラーの文脈)", () => {
  // `log.error` の欄も許可リストで絞る。素通しだと、足された欄が既定で乗る
  it("ログの見出しは通し、本文は落とす", () => {
    expect(scrubFields({ event: "karte_failed", session_id: "ses_1", title: "判別式" })).toEqual({
      event: "karte_failed",
      session_id: "ses_1",
    });
  });
});
