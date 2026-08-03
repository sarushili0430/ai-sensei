import {
  type Topic,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  prerequisitesOf,
} from "@ai-sensei/curriculum";

/**
 * サーバ側ガード(二重ガードの2枚目)。
 *
 * プロンプトで「写真に写っている内容 ∩ カリキュラムマップの範囲」に限定しても、
 * LLMは範囲外に滑る。ここで機械的に照合し、外れたものは再生成させる。
 * 由来: handoff §4「ガードレールの実装(二重ガード)」。
 */

export type AllowedTopics = {
  /** 写真から検出した単元。質問の主戦場。 */
  primary: ReadonlySet<string>;
  /** 前提トピック。「そもそも判別式って何?」の深掘りを許す範囲。 */
  prerequisite: ReadonlySet<string>;
};

export type BuildAllowedTopicsOptions = {
  /** 前提を何段たどるか。0なら深掘りを許さない。 */
  prerequisiteDepth?: number;
};

/**
 * 写真から検出したtopic_idを起点に、後輩AIが触れてよい話題の集合を作る。
 * 未知のIDは黙って捨てる(呼び出し側が空集合を見て再解析を判断する)。
 */
export function buildAllowedTopics(
  detectedTopicIds: readonly string[],
  options: BuildAllowedTopicsOptions = {},
): AllowedTopics {
  const depth = options.prerequisiteDepth ?? 1;
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

export const rejectionReasons = [
  /** topic_idの形が壊れている。 */
  "malformed_topic_id",
  /** 形は正しいがカリキュラムマップにない(大学数学・他教科など)。 */
  "unknown_topic_id",
  /** カリキュラム内だが、この写真の許可リストに入っていない。 */
  "topic_not_allowed",
  /** 質問文が答えを与えてしまっている。 */
  "answer_leak",
  /** 高校数学の範囲外を示す語が本文に入っている。 */
  "out_of_scope_wording",
  /** 質問になっていない(相づちだけ等)。 */
  "not_a_question",
] as const;
export type RejectionReason = (typeof rejectionReasons)[number];

export type GeneratedQuestion = {
  topic_id: string;
  text: string;
};

export type GuardVerdict = { ok: true } | { ok: false; reason: RejectionReason; detail: string };

/**
 * 高校数学の外側を指す語。写真にたまたま大学範囲のメモが写っていても、
 * 後輩がそこに食いつかないようにする。
 */
export const outOfScopeTerms = [
  "偏微分",
  "重積分",
  "固有値",
  "固有ベクトル",
  "行列式",
  "ヤコビアン",
  "テイラー展開",
  "マクローリン展開",
  "ラプラス変換",
  "フーリエ変換",
  "微分方程式",
  "イプシロンデルタ",
  "ε-δ",
  "線形代数",
  "群論",
  "位相空間",
  "ロピタルの定理",
];

/**
 * 答えを与えてしまっている質問を弾く。
 * このアプリの根幹(答えは教えない)なので、プロンプトだけに頼らない。
 */
export const answerLeakPatterns: RegExp[] = [
  /答えは/,
  /正解は/,
  /解答は/,
  /この問題の解き方は/,
  /まず[^。]{0,20}してから[^。]{0,20}すれば(?:解け|求め|でき)/,
  /(?:に|と)なりますよ(?:ね)?[。!]/,
  /だから答え/,
];

export function containsAnswerLeak(text: string): boolean {
  return answerLeakPatterns.some((pattern) => pattern.test(text));
}

export function containsOutOfScopeTerm(text: string): string | undefined {
  const normalized = text.normalize("NFKC");
  return outOfScopeTerms.find((term) => normalized.includes(term));
}

const QUESTION_ENDINGS = /[?？]|(?:ですか|ますか|でしょうか|んですか|かな|かなあ|教えて)/;

/**
 * 後輩AIが作った質問1件を検査する。
 * 落ちた場合、呼び出し側は reason をプロンプトに添えて再生成させる。
 */
export function checkQuestion(question: GeneratedQuestion, allowed: AllowedTopics): GuardVerdict {
  if (!isWellFormedTopicId(question.topic_id)) {
    return {
      ok: false,
      reason: "malformed_topic_id",
      detail: `topic_idの形式が不正: ${question.topic_id}`,
    };
  }
  if (!isKnownTopicId(question.topic_id)) {
    return {
      ok: false,
      reason: "unknown_topic_id",
      detail: `カリキュラムマップにないtopic_id: ${question.topic_id}`,
    };
  }
  if (!isAllowedTopic(allowed, question.topic_id)) {
    return {
      ok: false,
      reason: "topic_not_allowed",
      detail: `この写真の許可リストにないtopic_id: ${question.topic_id}`,
    };
  }

  const outOfScope = containsOutOfScopeTerm(question.text);
  if (outOfScope !== undefined) {
    return {
      ok: false,
      reason: "out_of_scope_wording",
      detail: `高校数学の範囲外の語: ${outOfScope}`,
    };
  }
  if (containsAnswerLeak(question.text)) {
    return { ok: false, reason: "answer_leak", detail: "質問が答えを与えてしまっています" };
  }
  if (!QUESTION_ENDINGS.test(question.text)) {
    return { ok: false, reason: "not_a_question", detail: "質問の形になっていません" };
  }

  return { ok: true };
}

export type FilterResult = {
  accepted: GeneratedQuestion[];
  rejected: { question: GeneratedQuestion; reason: RejectionReason; detail: string }[];
};

export function filterQuestions(
  questions: readonly GeneratedQuestion[],
  allowed: AllowedTopics,
): FilterResult {
  const result: FilterResult = { accepted: [], rejected: [] };
  for (const question of questions) {
    const verdict = checkQuestion(question, allowed);
    if (verdict.ok) result.accepted.push(question);
    else result.rejected.push({ question, reason: verdict.reason, detail: verdict.detail });
  }
  return result;
}

/** 再生成プロンプトに添える、落ちた理由の説明。 */
export const rejectionGuidance: Record<RejectionReason, string> = {
  malformed_topic_id: "topic_idは M2-ZUKEI-ENCHOKU の形式で、許可リストからそのまま選ぶこと。",
  unknown_topic_id: "topic_idは渡された許可リストにあるものだけを使うこと。新しく作らないこと。",
  topic_not_allowed: "写真に写っていない単元には触れないこと。許可リストの範囲で聞き直すこと。",
  answer_leak: "答えや解き方を言わないこと。わからない後輩として、理由をたずねるだけにすること。",
  out_of_scope_wording: "高校数学の範囲を超える用語を使わないこと。",
  not_a_question: "相づちではなく、質問の形で1つだけたずねること。",
};

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
