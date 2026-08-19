/**
 * カリキュラムの前提グラフを、人が棚卸しできる形で出力する。
 *
 * 前提の辺は「この単元 -> この説明に必要な前提」の向きで保存されている。
 * そのため入次数0は「どの単元からも前提として参照されていない単元」を表す。
 * 主要単元から根へ向かう到達可能集合と並べることで、孤立した系列や
 * 辺の張り忘れをデータ変更のレビューで見つける。
 *
 *   pnpm run verify:curriculum
 */
import { relative, resolve } from "node:path";
import {
  type Topic,
  type TrackId,
  curricula,
  topics,
  topicsForTracks,
  trackIds,
} from "../packages/curriculum/src/index.ts";

export type PrerequisiteNode = Pick<Topic, "id" | "prerequisites">;

/**
 * 課程ごとの代表的な終着単元。系列が根までつながっているかを継続して見る標本。
 * 1系列だけを選ぶと別領域の切断を見逃すため、文法・読解、数式・図形・統計を分けて置く。
 */
export const majorTopicIdsByTrack = {
  hs_math_ja: ["M2-ZUKEI-KISEKI-RYOIKI", "MB-TOKEI-SUITEI", "M3-SEKIBUN-OYO", "MC-FUKUSO-HEIMEN"],
  hs_math_en: ["A2-COORD-LOCUS", "A2-SEQ-RECURSION", "CL-INT-VOLUME", "ST-INFER-TEST"],
  jhs_math_ja: ["J3-KAZUSHIKI-NIJI-HOTEISHIKI", "J3-ZUKEI-SANHEIHO", "J3-DATA-HYOHON"],
  jhs_english_ja: ["JE-DOMEISHI", "JE-KANKEI-DAIMEISHI", "JE-KATEIHO"],
  hs_english_ja: ["E1-BUNPO-KOZO", "E2-DOKKAI-FUKUSU", "L1-KAKU-RONSHO"],
} as const satisfies Record<TrackId, readonly string[]>;

/** どの単元からも前提として参照されていないIDを、入力順で返す。 */
export function unreferencedTopicIds(nodes: readonly PrerequisiteNode[]): string[] {
  const known = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));

  for (const node of nodes) {
    for (const prerequisiteId of node.prerequisites) {
      if (!known.has(prerequisiteId)) continue;
      incoming.set(prerequisiteId, (incoming.get(prerequisiteId) ?? 0) + 1);
    }
  }

  return nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
}

/**
 * 前提を1つも持たないID(出次数0 = 系列の根)を、入力順で返す。
 *
 * **張り忘れはこちらに出る。** Issue #148 の詰まりは「動名詞から be動詞へ辿れない」で、
 * 原因は中間にある `JE-BUNKOZO-KIHON` の `prerequisites` が空だったこと —
 * 入次数0(終着単元)の一覧には現れない形の切断だった。
 * ここに並ぶのは「本当に根なのか、前提を書き忘れたのか」を人が判断する候補で、
 * be動詞・正負の数のような真の根は並んだままで正しい。
 */
export function rootTopicIds(nodes: readonly PrerequisiteNode[]): string[] {
  const known = new Set(nodes.map((node) => node.id));
  return nodes
    .filter((node) => !node.prerequisites.some((prerequisiteId) => known.has(prerequisiteId)))
    .map((node) => node.id);
}

/**
 * 起点自身と、そこから前提方向へ到達できるIDを幅優先で返す。
 * 訪問済み集合を先に見るため、壊れた入力に循環があっても必ず有限回で止まる。
 */
export function reachableTopicIds(nodes: readonly PrerequisiteNode[], startId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(startId)) return [];

  const visited = new Set<string>();
  const pending = [startId];
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    for (const prerequisiteId of byId.get(id)?.prerequisites ?? []) {
      if (byId.has(prerequisiteId) && !visited.has(prerequisiteId)) pending.push(prerequisiteId);
    }
  }
  return [...visited];
}

export type PrerequisiteGraphAudit = {
  unreferenced: {
    track: TrackId;
    total: number;
    topics: { id: string; topic: string }[];
  }[];
  roots: {
    track: TrackId;
    total: number;
    topics: { id: string; topic: string }[];
  }[];
  reachability: {
    track: TrackId;
    topicId: string;
    reachableCount: number;
  }[];
  missingMajorTopicIds: string[];
};

export function auditPrerequisiteGraph(): PrerequisiteGraphAudit {
  const unreferenced = new Set(unreferencedTopicIds(topics));
  const roots = new Set(rootTopicIds(topics));
  const known = new Set(topics.map((topic) => topic.id));
  const missingMajorTopicIds: string[] = [];

  return {
    unreferenced: trackIds.map((track) => ({
      track,
      total: curricula[track].topics.length,
      topics: topicsForTracks([track])
        .filter((topic) => unreferenced.has(topic.id))
        .map((topic) => ({ id: topic.id, topic: topic.topic })),
    })),
    roots: trackIds.map((track) => ({
      track,
      total: curricula[track].topics.length,
      topics: topicsForTracks([track])
        .filter((topic) => roots.has(topic.id))
        .map((topic) => ({ id: topic.id, topic: topic.topic })),
    })),
    reachability: trackIds.flatMap((track) =>
      majorTopicIdsByTrack[track].map((topicId) => {
        if (!known.has(topicId)) missingMajorTopicIds.push(topicId);
        return {
          track,
          topicId,
          reachableCount: reachableTopicIds(topics, topicId).length,
        };
      }),
    ),
    missingMajorTopicIds,
  };
}

export function formatPrerequisiteGraphAudit(audit: PrerequisiteGraphAudit): string {
  const lines = [
    "前提グラフ監査 (辺: 単元 -> 前提)",
    "入次数0 = どの単元からも前提として参照されていない単元",
    "",
  ];

  for (const group of audit.unreferenced) {
    lines.push(`[${group.track}] 入次数0: ${group.topics.length}/${group.total}`);
    for (const topic of group.topics) lines.push(`  - ${topic.id} — ${topic.topic}`);
  }

  lines.push(
    "",
    "出次数0 = 前提を1つも持たない単元(系列の根。ここに新しい単元が現れたら張り忘れを疑う)",
  );
  for (const group of audit.roots) {
    lines.push(`[${group.track}] 出次数0: ${group.topics.length}/${group.total}`);
    for (const topic of group.topics) lines.push(`  - ${topic.id} — ${topic.topic}`);
  }

  lines.push("", "主要単元からの到達可能集合 (起点を含む)");
  for (const metric of audit.reachability) {
    lines.push(`  - [${metric.track}] ${metric.topicId}: ${metric.reachableCount}件`);
  }
  return lines.join("\n");
}

function main(): void {
  const audit = auditPrerequisiteGraph();
  console.log(formatPrerequisiteGraphAudit(audit));
  if (audit.missingMajorTopicIds.length > 0) {
    console.error(`\n主要単元のIDが見つかりません: ${audit.missingMajorTopicIds.join(", ")}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(
    resolve(process.argv[1]),
    resolve(import.meta.dirname, "verify-curriculum-prerequisites.ts"),
  ) === "";

if (invokedDirectly) main();
