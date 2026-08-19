import { describe, expect, it } from "vitest";
import {
  auditPrerequisiteGraph,
  formatPrerequisiteGraphAudit,
  reachableTopicIds,
  rootTopicIds,
  unreferencedTopicIds,
} from "./verify-curriculum-prerequisites.ts";

describe("前提グラフ監査", () => {
  it("どこからも前提として参照されない単元を返す", () => {
    const nodes = [
      { id: "A", prerequisites: ["B"] },
      { id: "B", prerequisites: [] },
      { id: "C", prerequisites: ["B"] },
    ];

    expect(unreferencedTopicIds(nodes)).toEqual(["A", "C"]);
  });

  it("前提を1つも持たない単元(系列の根)を返す", () => {
    const nodes = [
      { id: "A", prerequisites: ["B"] },
      { id: "B", prerequisites: [] },
      // 知らないIDしか指していない単元は、辿れる前提が無いので根と同じ扱いにする。
      { id: "C", prerequisites: ["MISSING"] },
    ];

    expect(rootTopicIds(nodes)).toEqual(["B", "C"]);
  });

  it("循環した入力でも、訪問済み集合で有限回に止まる", () => {
    const nodes = [
      { id: "A", prerequisites: ["B"] },
      { id: "B", prerequisites: ["C"] },
      { id: "C", prerequisites: ["A"] },
    ];

    expect(reachableTopicIds(nodes, "A")).toEqual(["A", "B", "C"]);
  });

  it("主要単元の到達可能数を全トラックで固定する", () => {
    const audit = auditPrerequisiteGraph();
    expect(audit.missingMajorTopicIds).toEqual([]);
    expect(
      Object.fromEntries(audit.reachability.map((entry) => [entry.topicId, entry.reachableCount])),
    ).toEqual({
      "M2-ZUKEI-KISEKI-RYOIKI": 20,
      "MB-TOKEI-SUITEI": 11,
      "M3-SEKIBUN-OYO": 27,
      "MC-FUKUSO-HEIMEN": 19,
      "A2-COORD-LOCUS": 9,
      "A2-SEQ-RECURSION": 8,
      "CL-INT-VOLUME": 21,
      "ST-INFER-TEST": 8,
      "J3-KAZUSHIKI-NIJI-HOTEISHIKI": 8,
      "J3-ZUKEI-SANHEIHO": 8,
      "J3-DATA-HYOHON": 3,
      "JE-DOMEISHI": 5,
      "JE-KANKEI-DAIMEISHI": 10,
      "JE-KATEIHO": 6,
      "E1-BUNPO-KOZO": 13,
      "E2-DOKKAI-FUKUSU": 7,
      "L1-KAKU-RONSHO": 10,
    });
  });

  it("入次数0一覧と到達可能数をレビュー用の文面に出す", () => {
    const output = formatPrerequisiteGraphAudit(auditPrerequisiteGraph());

    expect(output).toContain("入次数0 = どの単元からも前提として参照されていない単元");
    expect(output).toContain("[jhs_english_ja] 入次数0:");
    expect(output).toContain("JE-DOMEISHI: 5件");
  });

  /**
   * この Issue の切断は「中間の単元が前提を1つも持っていない」形だったので、
   * 根の一覧に `JE-BUNKOZO-KIHON` が戻ってきたら、また be動詞まで戻れなくなっている。
   * be動詞そのものは真の根なので、並んだままで正しい。
   */
  it("出次数0一覧に、真の根だけが並ぶ", () => {
    const output = formatPrerequisiteGraphAudit(auditPrerequisiteGraph());

    expect(output).toContain("出次数0 = 前提を1つも持たない単元");
    expect(output).toContain("- JE-DOUSHI-BE —");
    expect(output).not.toContain("- JE-BUNKOZO-KIHON —");
  });
});
