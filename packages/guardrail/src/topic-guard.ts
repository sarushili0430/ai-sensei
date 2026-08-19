import {
  type CurriculumLocale,
  type Topic,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  localeOfTopicId,
  prerequisitesOf,
} from "@ai-sensei/curriculum";

/**
 * セッションで扱ってよい単元の集合と、カルテのtopic_idを照合する。
 *
 * 写真から検出した単元と前提を許可リストにし、先輩のプロンプトへ渡す。
 * カルテ生成後は、穴に付いたtopic_idがその範囲を越えていないか機械的に照合する。
 */

export type AllowedTopics = {
  /** 写真から検出した単元。授業の主題。 */
  primary: ReadonlySet<string>;
  /** 前提トピック。先輩が詰まりの原因まで戻って教えてよい範囲。 */
  prerequisite: ReadonlySet<string>;
};

/**
 * 1つのセッションでたどる前提の深さ。会話では**前提チェーン全体**を許可する。
 *
 * 許可リストの役目は「どこまで戻るか」を固定することではなく、カリキュラム外へ
 * 出ないためのガードレール。実際に戻る深さは、先輩が生徒にやらせて確かめる
 * 多段の切り分けと残り時間で決める。固定2段のままだと、3段目より根にある穴は
 * 生徒が詰まったと観測できても、板書の `topic_ids` に付けられない。
 *
 * **経緯。** 2026-08-10 までは既定1段で、プロンプトだけが2段と説明していたため、
 * その日に既定を2段へ直した。当時の実データでは、検出1〜2件の許可集合は
 * 1段=約2.0〜3.4件、2段=約2.9〜4.8件、3段=約3.4〜5.8件、連鎖は最長5段だった。
 * これは「2段でほぼ飽和する」と判断した**当時の記録**であり、現在の下限ではない。
 * 2026-08-19 に前提グラフを中学の根までつないだため、固定段数ではなく全体へ改めた。
 *
 * 全チェーン化後の実測(平均 / 最大、起点を含む):
 *
 *   | track | 検出1件 | 検出2件 |
 *   | --- | --- | --- |
 *   | hs_math_ja | 9.35 / 27 | 15.93 / 38 |
 *   | hs_math_en | 5.67 / 21 | 10.08 / 29 |
 *   | jhs_math_ja | 3.33 / 8 | 5.97 / 13 |
 *   | jhs_english_ja | 3.88 / 10 | 5.95 / 12 |
 *   | hs_english_ja | 6.22 / 13 | 9.74 / 19 |
 *
 * 最大38件は長いが、辺は「説明に不可欠な前提」だけなので、無関係な系列は混ざらない。
 * 一覧を狭めて根の穴を再び禁止するより、診断で実際に教える1〜3件を選ぶ。
 * `prerequisitesOf()` は訪問済み `Map` を持ち、巡回済みのIDと起点を再訪しない。
 * 整合性検査も循環を落とすため、この無制限値で循環参照が無限ループすることはない。
 *
 * カルテ生成・transcript 側が `{ prerequisiteDepth: 0 }` を明示しているのは別の判断で、
 * **そちらは「会話で実際に触れた範囲」を数えたい**ため。ここを変えても影響しない。
 */
export const conversationPrerequisiteDepth = Number.POSITIVE_INFINITY;

export type BuildAllowedTopicsOptions = {
  /**
   * 前提を何段たどるか。0なら深掘りを許さない。
   * 既定は {@link conversationPrerequisiteDepth}(前提チェーン全体)。
   */
  prerequisiteDepth?: number;
};

/**
 * 写真から検出したtopic_idを起点に、先輩が触れてよい話題の集合を作る。
 * 未知のIDは黙って捨てる(呼び出し側が空集合を見て再解析を判断する)。
 */
export function buildAllowedTopics(
  detectedTopicIds: readonly string[],
  options: BuildAllowedTopicsOptions = {},
): AllowedTopics {
  const depth = options.prerequisiteDepth ?? conversationPrerequisiteDepth;
  const primary = new Set<string>();
  for (const id of detectedTopicIds) {
    if (isKnownTopicId(id)) primary.add(id);
  }

  const prerequisite = new Set<string>();
  if (depth > 0) {
    for (const id of primary) {
      for (const topic of prerequisitesOf(id, depth)) {
        if (!primary.has(topic.id)) prerequisite.add(topic.id);
      }
    }
  }

  return { primary, prerequisite };
}

export function isAllowedTopic(allowed: AllowedTopics, topicId: string): boolean {
  return allowed.primary.has(topicId) || allowed.prerequisite.has(topicId);
}

export function allowedTopicList(allowed: AllowedTopics): Topic[] {
  return [...allowed.primary, ...allowed.prerequisite]
    .map((id) => findTopic(id))
    .filter((topic): topic is Topic => topic !== undefined);
}

/**
 * この許可リストがどちらの課程のものか。
 *
 * topic_id の接頭辞で決まるので、セッションのロケールを別途持ち回らなくても
 * 許可単元から会話の言語を一意に決められる。
 */
export function allowedTopicsLocale(allowed: AllowedTopics): CurriculumLocale {
  for (const id of allowed.primary) {
    const locale = localeOfTopicId(id);
    if (locale) return locale;
  }
  for (const id of allowed.prerequisite) {
    const locale = localeOfTopicId(id);
    if (locale) return locale;
  }
  return "ja";
}

export const rejectionReasons = [
  /** topic_idの形が壊れている。 */
  "malformed_topic_id",
  /** 形は正しいがカリキュラムマップにない(大学数学・他教科など)。 */
  "unknown_topic_id",
  /** カリキュラム内だが、このセッションの許可リストに入っていない。 */
  "topic_not_allowed",
] as const;
export type RejectionReason = (typeof rejectionReasons)[number];

/**
 * カルテの穴に付いたtopic_idを検査する。
 * 会話中に許可された範囲を超えたタグが付くと、復習の通知まで的外れになる。
 */
export function filterHoleTopicIds<T extends { topic_id: string }>(
  holes: readonly T[],
  allowed: AllowedTopics,
): { accepted: T[]; rejected: { hole: T; reason: RejectionReason }[] } {
  const accepted: T[] = [];
  const rejected: { hole: T; reason: RejectionReason }[] = [];
  for (const hole of holes) {
    if (!isWellFormedTopicId(hole.topic_id)) {
      rejected.push({ hole, reason: "malformed_topic_id" });
    } else if (!isKnownTopicId(hole.topic_id)) {
      rejected.push({ hole, reason: "unknown_topic_id" });
    } else if (!isAllowedTopic(allowed, hole.topic_id)) {
      rejected.push({ hole, reason: "topic_not_allowed" });
    } else {
      accepted.push(hole);
    }
  }
  return { accepted, rejected };
}
