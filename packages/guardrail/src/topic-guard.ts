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
 * 1つのセッションで前提を何段たどるか。**プロンプトが先輩に約束している段数と同じ値。**
 *
 * `prompts/senpai_board.{ja,en}.md` は許可リストについて
 * 「写真の単元と**その前提が2段ぶん**入っています」と書いている。
 * 先輩は「判別式が出てこなかったなら判別式から」教えるために前提へ戻るので、
 * **前提へ戻れることは授業モードの本体**(戻れないと、詰まった生徒を連れて行けない)。
 *
 * **2026-08-10 まで、ここは既定1段だった。** プロンプトは2段と説明しているのに
 * `backend/api` が既定で呼んでいたため、2段目の前提は許可リストに入らず、
 * 先輩へ「選んでよい単元」として渡っていなかった。
 * 板書配送の `validateStep()` は手順のスキーマとLaTeXを検証する関数で、
 * topic_idを許可集合と照合しない。旧質問ガードに弾かれていたわけではない。
 * 呼び出し側で `{ prerequisiteDepth: 2 }` を書き足すのではなく**既定を直した**のは、
 * ずれの原因が「呼び出し側がオプションを書き忘れた」形そのものだから —
 * 既定が正しくないと、次に増える呼び出し側がまた同じずれを持ち込む。
 *
 * **2段で止める根拠**(2026-08-10 に実カリキュラムで計測):
 * 検出1〜2件から作る許可集合は 1段=約2.0〜3.4件、**2段=約2.9〜4.8件**、3段=約3.4〜5.8件。
 * 前提の連鎖はいちばん長いもので5段しかなく、3段目以降はほとんど増えない。
 * プロンプトに貼る一覧としても、2段までなら最大10件で収まる。
 *
 * 前提の辺は**学習の順序に沿って伸びる**ので、深くしても無関係な単元には届かない
 * (三角関数の許可リストにベクトルは入らない)。
 *
 * カルテ生成・transcript 側が `{ prerequisiteDepth: 0 }` を明示しているのは別の判断で、
 * **そちらは「会話で実際に触れた範囲」を数えたい**ため。ここを変えても影響しない。
 */
export const conversationPrerequisiteDepth = 2;

export type BuildAllowedTopicsOptions = {
  /**
   * 前提を何段たどるか。0なら深掘りを許さない。
   * 既定は {@link conversationPrerequisiteDepth}(プロンプトが約束している段数)。
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
  /** カリキュラム内だが、この写真の許可リストに入っていない。 */
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
