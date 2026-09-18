import { describe, expect, it } from "vitest";
import {
  amendmentNote,
  applicableRubrics,
  findRubric,
  renderRubrics,
  rubricIds,
  rubricSkipReason,
  rubrics,
} from "./rubrics.ts";

/**
 * ルーブリックのテスト。**本文が旧憲法に戻っていないか**を見るのが本題。
 *
 * ここが「答えを教えない」に戻ると、ジャッジは製品が意図してやっていることを
 * 毎回 fail と宣告する。プロンプトを直した人が数字を見て「悪化した」と読み、
 * 改正前の作りへ巻き戻す — いちばん高くつく壊れ方なので、文面を機械で押さえる。
 */

describe("rubrics", () => {
  it("R1〜R7 が仕様書の順に並び、id は重複しない", () => {
    expect(rubrics.map((rubric) => rubric.code)).toEqual([
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
    ]);
    expect(new Set(rubricIds).size).toBe(rubrics.length);
    expect(findRubric("answer_before_student")?.code).toBe("R1");
    expect(findRubric("no_such_rule")).toBeUndefined();
  });

  it("どのルールにも判定基準の本文がある(空の基準をジャッジへ渡さない)", () => {
    for (const rubric of rubrics) {
      expect(rubric.criteria.length).toBeGreaterThan(40);
      expect(rubric.title.length).toBeGreaterThan(0);
      expect(rubric.stages.length).toBeGreaterThan(0);
    }
  });

  it("約束1の改正が本文に書いてある(教えるのは違反ではない・違反は順序)", () => {
    expect(amendmentNote).toContain("2026-08-09");
    expect(amendmentNote).toContain("違反ではない");
    expect(amendmentNote).toContain("順序");

    const r1 = findRubric("answer_before_student");
    expect(r1?.criteria).toContain("ターンの順序");
    // 「生徒が答えたあとに教えるのは正しい」= 改正後の側。ここが抜けると旧憲法で裁く。
    expect(r1?.criteria).toContain("正しい振る舞い");
  });

  it("R2 は採点の宣告だけを違反にする(励ましを違反にしない)", () => {
    const criteria = findRubric("grading_language")?.criteria ?? "";
    expect(criteria).toContain("合ってる");
    expect(criteria).toContain("fail ではない例");
  });
});

describe("rubricSkipReason", () => {
  const board = { stage: "board" as const, hasKarte: false };
  const loop = { stage: "loop" as const, hasKarte: true };

  it("L1 では R1 を判定しない(生徒の発話が無いので順序が無い)", () => {
    const r1 = findRubric("answer_before_student");
    expect(r1).toBeDefined();
    if (r1 === undefined) return;
    expect(rubricSkipReason(r1, board)).toContain("生徒の発話が無い");
    expect(rubricSkipReason(r1, loop)).toBeUndefined();
  });

  it("カルテが無い試行では R7 を判定しない", () => {
    const r7 = findRubric("karte_grounding");
    expect(r7).toBeDefined();
    if (r7 === undefined) return;
    expect(rubricSkipReason(r7, { stage: "loop", hasKarte: false })).toContain("カルテ");
    expect(rubricSkipReason(r7, loop)).toBeUndefined();
  });

  it("残りのルールは L1 でも判定する", () => {
    expect(applicableRubrics(board).map((rubric) => rubric.code)).toEqual([
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
    ]);
    expect(applicableRubrics(loop).map((rubric) => rubric.code)).toEqual([
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
    ]);
  });
});

describe("renderRubrics", () => {
  it("rule_id を見出しに入れる(ジャッジが返す鍵と同じ綴り)", () => {
    const rendered = renderRubrics();
    for (const rubric of rubrics) {
      expect(rendered).toContain(`\`${rubric.id}\``);
      expect(rendered).toContain(rubric.title);
    }
  });

  it("渡したぶんだけを出す(判定しないルールの本文をジャッジに見せない)", () => {
    const rendered = renderRubrics(applicableRubrics({ stage: "board", hasKarte: false }));
    expect(rendered).not.toContain("answer_before_student");
    expect(rendered).not.toContain("karte_grounding");
    expect(rendered).toContain("teach_back_handover");
  });
});
