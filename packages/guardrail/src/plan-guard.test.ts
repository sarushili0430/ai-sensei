import { describe, expect, it } from "vitest";
import {
  checkPlanScope,
  filterPlanItems,
  planPrerequisiteDepth,
  planRejectionGuidance,
  planRejectionGuidanceByLocale,
  planRejectionReasons,
} from "./plan-guard.ts";
import { buildAllowedTopics, isAllowedTopic } from "./topic-guard.ts";

/** 2学期の中間 = 数IIの三角関数、という典型的なテスト範囲。 */
const trigScope = ["M2-SANKAKU-KAHO", "M2-SANKAKU-HOTEISHIKI"];

function allowedFor(scope: readonly string[] = trigScope) {
  const verdict = checkPlanScope(scope);
  if (!verdict.ok) throw new Error(`範囲が通りませんでした: ${verdict.detail}`);
  return verdict.allowed;
}

describe("checkPlanScope — 通すべきもの", () => {
  it("カリキュラム内の範囲を通し、前提つきの許可集合を返す", () => {
    const verdict = checkPlanScope(trigScope);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    expect(verdict.allowed.primary.has("M2-SANKAKU-KAHO")).toBe(true);
    // 三角関数の前提は三角比(数I)。復習日を置くのは家庭教師のふつうの組み方。
    expect(verdict.allowed.prerequisite.has("M1-KEIRYO-SANKAKUHI")).toBe(true);
  });

  it("海外の課程でも同じように通る", () => {
    const verdict = checkPlanScope(["PC-TRIG-IDENTITY", "PC-TRIG-EQUATION"]);
    expect(verdict.ok).toBe(true);
  });
});

describe("checkPlanScope — 弾くべきもの", () => {
  /**
   * **範囲は1つでも壊れていたら全体を落とす。**
   * 黙って1単元を捨てると、実際より狭いテストに向けた計画ができあがり、
   * 生徒は範囲の一部を勉強しないまま当日を迎える(しかも気づけない)。
   */
  it("1つでもカリキュラムにないIDがあれば、範囲ごと落とす", () => {
    const verdict = checkPlanScope([...trigScope, "M2-SONZAI-SHINAI"]);
    expect(verdict).toMatchObject({ ok: false, reason: "unknown_topic_id" });
  });

  it("形の壊れたIDを弾く", () => {
    expect(checkPlanScope(["三角関数"])).toMatchObject({
      ok: false,
      reason: "malformed_topic_id",
    });
  });

  it("空の範囲を弾く(範囲を作らずに聞き直させる)", () => {
    expect(checkPlanScope([])).toMatchObject({ ok: false, reason: "empty_scope" });
  });

  /**
   * 課程の混在は計画でだけ見る。混ざっているのは、LLMが両方のカリキュラムの
   * 記憶から引いたということで、**範囲の残りも信用できない**。
   */
  it("日本の課程と海外の課程が混ざった範囲を弾く", () => {
    const verdict = checkPlanScope(["M2-SANKAKU-KAHO", "PC-TRIG-IDENTITY"]);
    expect(verdict).toMatchObject({ ok: false, reason: "mixed_curricula" });
  });
});

describe("filterPlanItems", () => {
  it("範囲の単元を通す", () => {
    const result = filterPlanItems(
      [{ topic_id: "M2-SANKAKU-KAHO" }, { topic_id: "M2-SANKAKU-HOTEISHIKI" }],
      allowedFor(),
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
  });

  // 「まず三角比を思い出す日」。計画の単位は1日なので、前提の復習日は正当。
  it("範囲の前提にあたる復習日を通す", () => {
    const result = filterPlanItems([{ topic_id: "M1-KEIRYO-SANKAKUHI" }], allowedFor());
    expect(result.rejected).toEqual([]);
  });

  // これが塞ぎたかった穴そのもの。contract は前提関係を知らないので通してしまう。
  it("範囲外の単元を割り当てた日を落とす", () => {
    const result = filterPlanItems(
      [{ topic_id: "M2-SANKAKU-KAHO" }, { topic_id: "MB-SURETSU-TOSA-TOHI" }],
      allowedFor(),
    );
    expect(result.accepted).toEqual([{ topic_id: "M2-SANKAKU-KAHO" }]);
    expect(result.rejected).toMatchObject([{ reason: "topic_out_of_scope" }]);
  });

  /**
   * **割り当ては1件ずつ落とす**(範囲と扱いが違う)。
   * 1日が範囲外でも、残りの日は使える生成物なので。
   */
  it("落ちた日以外は残る", () => {
    const result = filterPlanItems(
      [
        { topic_id: "M2-SANKAKU-KAHO", what: "加法定理を導出する" },
        { topic_id: "大学数学", what: "テイラー展開" },
        { topic_id: "M2-SANKAKU-HOTEISHIKI", what: "三角方程式を解く" },
      ],
      allowedFor(),
    );
    expect(result.accepted.map((item) => item.what)).toEqual([
      "加法定理を導出する",
      "三角方程式を解く",
    ]);
    expect(result.rejected).toMatchObject([{ reason: "malformed_topic_id" }]);
  });

  it("捏造したIDを落とす", () => {
    const result = filterPlanItems([{ topic_id: "M2-SONZAI-SHINAI" }], allowedFor());
    expect(result.rejected).toMatchObject([{ reason: "unknown_topic_id" }]);
  });
});

/**
 * 前提をどこまで許すかは設計判断。2段で止めるのは、それ以上広げても増えるトピックが
 * 少なく(2段で飽和する)、「テスト対策」ではなく「課程のやり直し」になるため。
 */
describe("前提をどこまで許すか", () => {
  /**
   * **会話側と同じ値だが、追随はしない。**
   *
   * 当初は「計画のほうが深いはず」(単位が質問ではなく1日だから)としていたが、
   * 会話側がプロンプトの約束どおり2段に直った時点で同じ値になった。
   * それでも定数を分けたままにしてあるのは、**会話側は原価(セッション時間)の都合で
   * 浅くしたくなることがある**から。そのとき計画まで黙って追随すると、
   * 正当な復習日が範囲外として落ちはじめる。
   */
  it("会話側の深さが変わっても、計画の深さは動かない", () => {
    const plan = allowedFor(["M2-SANKAKU-HOTEISHIKI"]);
    // 三角方程式 → 加法定理(1段)→ 三角比(2段)。復習日として置ける。
    expect(isAllowedTopic(plan, "M1-KEIRYO-SANKAKUHI")).toBe(true);

    // 会話側を浅くしても、計画側は planPrerequisiteDepth のまま。
    const shallowConversation = buildAllowedTopics(["M2-SANKAKU-HOTEISHIKI"], {
      prerequisiteDepth: 1,
    });
    expect(isAllowedTopic(shallowConversation, "M1-KEIRYO-SANKAKUHI")).toBe(false);
    expect(planPrerequisiteDepth).toBe(2);
  });

  /**
   * 前提の辺は**科目の系列に沿って伸びる**ので、2段広げても別の系列には届かない。
   * ここが崩れると、深さを広げた瞬間に「三角関数の計画に数列」が通る。
   */
  it("深さを広げても、別の系列の単元までは届かない", () => {
    const plan = allowedFor();
    for (const unrelated of ["MB-SURETSU-TOSA-TOHI", "M2-ZUKEI-ENCHOKU", "MC-VECTOR-NAISEKI"]) {
      expect(isAllowedTopic(plan, unrelated), unrelated).toBe(false);
    }
  });

  it("深さは呼び出し側で上書きできる", () => {
    const shallow = checkPlanScope(["M2-SANKAKU-HOTEISHIKI"], { prerequisiteDepth: 1 });
    expect(shallow.ok).toBe(true);
    if (!shallow.ok) return;
    expect(isAllowedTopic(shallow.allowed, "M1-KEIRYO-SANKAKUHI")).toBe(false);
  });
});

describe("再生成の指示", () => {
  it("すべての理由に、両方の言語の指示がある", () => {
    for (const locale of ["ja", "en"] as const) {
      for (const reason of planRejectionReasons) {
        expect(
          planRejectionGuidanceByLocale[locale][reason].length,
          `${locale}/${reason}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(planRejectionGuidance).toBe(planRejectionGuidanceByLocale.ja);
  });

  /**
   * 「範囲外です」だけを返すと、LLMは**範囲のほうを書き換えて**辻褄を合わせにいく。
   * それは聞き取った事実の改竄で、計画が通っても生徒のテスト範囲とは別物になる。
   * 行き先(「その日の割り当てを差し替える」)まで書いてあることを固定する。
   */
  it("範囲外の指示が、範囲を書き換えない方向を向いている", () => {
    expect(planRejectionGuidanceByLocale.ja.topic_out_of_scope).toContain("範囲のほうを書き換えず");
    expect(planRejectionGuidanceByLocale.en.topic_out_of_scope).toContain(
      "Do not rewrite the range",
    );
  });

  it("英語の指示に日本語が混ざらない", () => {
    for (const reason of planRejectionReasons) {
      expect(planRejectionGuidanceByLocale.en[reason], reason).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    }
  });
});
