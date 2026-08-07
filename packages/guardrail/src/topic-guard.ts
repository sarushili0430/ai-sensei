import {
  type CurriculumLocale,
  type Topic,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  localeOfTopicId,
  prerequisitesOf,
  suggestTopics,
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

/**
 * この許可リストがどちらの課程のものか。
 *
 * topic_id の接頭辞で決まるので、セッションのロケールを別途持ち回らなくても
 * 「日本語の会話に英語の範囲外リストを当てる」事故が起きない。
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
  /** 質問文が答えを与えてしまっている。 */
  "answer_leak",
  /** 高校数学の範囲外を示す語が本文に入っている。 */
  "out_of_scope_wording",
  /** topic_idは許可内だが、質問文が別の単元の話をしている。 */
  "text_topic_mismatch",
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
 *
 * **課程ごとに違う。** 例えばロピタルの定理は日本の高校では範囲外だが、
 * AP Calculus では扱う。全部を一本のリストにすると、英語のセッションで
 * 教科書どおりの話題まで弾いてしまう。
 */
export const outOfScopeTermsByLocale: Record<CurriculumLocale, readonly string[]> = {
  ja: [
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
  ],
  en: [
    "partial derivative",
    "double integral",
    "triple integral",
    "eigenvalue",
    "eigenvector",
    "jacobian",
    "laplace transform",
    "fourier transform",
    "epsilon-delta",
    "linear algebra",
    "group theory",
    "ring theory",
    "topology",
    "manifold",
    "green's theorem",
    "stokes",
    "lagrange multiplier",
    "gradient vector",
  ],
};

/** 既定(ロケール未指定)では日本の課程のリストを使う。 */
export const outOfScopeTerms = outOfScopeTermsByLocale.ja;

/**
 * 答えを与えてしまっている質問を弾く。
 * このアプリの根幹(答えは教えない)なので、プロンプトだけに頼らない。
 *
 * 言語ごとに書く。日本語の言い回しだけを見ていると、英語の会話では
 * "The answer is 2." が素通りしてしまう。
 */
export const answerLeakPatternsByLocale: Record<CurriculumLocale, readonly RegExp[]> = {
  ja: [
    /答えは/,
    /正解は/,
    /解答は/,
    /この問題の解き方は/,
    /まず[^。]{0,20}してから[^。]{0,20}すれば(?:解け|求め|でき)/,
    /(?:に|と)なりますよ(?:ね)?[。!]/,
    /だから答え/,
    // 確認の形をした答え。「x=2ですよね?」「2点で交わるんですよね?」は
    // 疑問符が付いていても中身は答えそのものなので、質問として通してはいけない。
    /[=＝][^。?？]{0,12}(?:です|でしょ)(?:よね|ね)?[?？]/,
    /(?:答え|解|値|個数|最大値|最小値|範囲)\s*(?:は|が)[^。?？]{0,20}(?:です|になり)(?:ます)?(?:よね|ね)?[?？]/,
    /\d[^。?？]{0,12}(?:ですよね|んですよね|になりますよね)[?？]/,
    /(?:交わる|接する|成り立つ|同じ|等しい)(?:ん)?ですよね[?？]/,
  ],
  en: [
    /\bthe (?:answer|solution|correct answer) (?:is|would be)\b/i,
    /\bthe answer to (?:this|that|it) is\b/i,
    /\bhere'?s how (?:to|you) (?:solve|do|get)\b/i,
    /\bthe way to solve (?:this|that|it) is\b/i,
    /\byou (?:just )?(?:need to|have to) [^.?!]{0,40}\band then\b[^.?!]{0,40}\b(?:solve|get|find|works out)\b/i,
    // 確認の形をした答え。"x = 2, right?" は疑問符が付いていても中身は答え。
    /[=＝]\s*-?[\w.√^/]+\s*,?\s*(?:right|correct|isn'?t it|yeah)\s*[?？]/i,
    /\bit'?s\s+-?\d[^.?!]{0,12}[?？]/i,
    /\b(?:they|it|the lines?|the circles?|both sides?)\s+(?:intersect|touch|match|are equal|are the same)s?\s*,?\s*(?:right|correct)\s*[?？]/i,
    /\bso (?:the )?(?:answer|value|maximum|minimum|number of (?:roots|solutions)) is\b/i,
  ],
};

/** 既定(ロケール未指定)では日本語のパターン。 */
export const answerLeakPatterns: readonly RegExp[] = answerLeakPatternsByLocale.ja;

/**
 * 答えの漏れを見る。
 *
 * ロケールを渡さない呼び出しは**両方の言語で照合する**。会話の言語を
 * 取り違えたときに素通しするより、多めに拾って記録に残すほうが安全なため。
 */
export function containsAnswerLeak(text: string, locale?: CurriculumLocale): boolean {
  const sets = locale
    ? [answerLeakPatternsByLocale[locale]]
    : Object.values(answerLeakPatternsByLocale);
  return sets.some((patterns) => patterns.some((pattern) => pattern.test(text)));
}

/**
 * 範囲外の語を見る。
 *
 * **ロケールは必ず渡す。** 課程ごとにリストが違うので、省略すると
 * 日本の高校の範囲外リスト(ロピタルの定理など)を英語の会話に当ててしまう。
 */
export function containsOutOfScopeTerm(
  text: string,
  locale: CurriculumLocale = "ja",
): string | undefined {
  const normalized = text.normalize("NFKC").toLowerCase();
  return outOfScopeTermsByLocale[locale].find((term) => normalized.includes(term));
}

const QUESTION_ENDINGS: Record<CurriculumLocale, RegExp> = {
  ja: /[?？]|(?:ですか|ますか|でしょうか|んですか|かな|かなあ|教えて)/,
  en: /[?？]|\b(?:why|how|what|which|when|where|could you|can you|tell me|walk me through)\b/i,
};

/**
 * 質問文そのものが、許可された単元の話をしているかを見る。
 *
 * topic_idはLLMが自己申告する値なので、許可リストに載っているIDを付けたまま
 * 別の単元を聞くことができてしまう(例: topic_id=円と直線 のまま「数列の和は
 * どう出すんですか?」)。**IDだけを信用しない**のがこの二枚目のガードの役目なので、
 * 本文からも単元を推定して突き合わせる。
 *
 * 判定は保守的にする。本文から単元をひとつも推定できないとき(「最初の一歩を
 * それにしたのはどうしてですか?」のような一般的な問い)は**通す**。
 * 推定できた候補が**すべて**許可外だったときだけ落とす。
 */
export function mentionsOnlyDisallowedTopics(text: string, allowed: AllowedTopics): boolean {
  // 候補は許可リストと同じ課程から引く。全課程から引くと、英語の質問に
  // 日本語のトピックだけが並び、「どれも許可外」に見えて落ちてしまう。
  const candidates = suggestTopics(text, 3, { locale: allowedTopicsLocale(allowed) });
  if (candidates.length === 0) return false;
  return candidates.every((topic) => !isAllowedTopic(allowed, topic.id));
}

/**
 * 後輩AIが作った質問1件を検査する。
 * 落ちた場合、呼び出し側は reason をプロンプトに添えて再生成させる。
 */
export function checkQuestion(question: GeneratedQuestion, allowed: AllowedTopics): GuardVerdict {
  const locale = allowedTopicsLocale(allowed);
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

  const outOfScope = containsOutOfScopeTerm(question.text, locale);
  if (outOfScope !== undefined) {
    return {
      ok: false,
      reason: "out_of_scope_wording",
      detail: `高校数学の範囲外の語: ${outOfScope}`,
    };
  }
  if (containsAnswerLeak(question.text, locale)) {
    return { ok: false, reason: "answer_leak", detail: "質問が答えを与えてしまっています" };
  }
  if (mentionsOnlyDisallowedTopics(question.text, allowed)) {
    return {
      ok: false,
      reason: "text_topic_mismatch",
      detail: "topic_idは許可内ですが、質問文が写真にない単元の話になっています",
    };
  }
  if (!QUESTION_ENDINGS[locale].test(question.text)) {
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

/**
 * 再生成プロンプトに添える、落ちた理由の説明。
 * LLMにそのまま渡すので、**会話の言語で書く**(日本語の指示を英語の会話に
 * 混ぜると、次の質問だけ日本語で返ってくる)。
 */
export const rejectionGuidanceByLocale: Record<
  CurriculumLocale,
  Record<RejectionReason, string>
> = {
  ja: {
    malformed_topic_id: "topic_idは M2-ZUKEI-ENCHOKU の形式で、許可リストからそのまま選ぶこと。",
    unknown_topic_id: "topic_idは渡された許可リストにあるものだけを使うこと。新しく作らないこと。",
    topic_not_allowed: "写真に写っていない単元には触れないこと。許可リストの範囲で聞き直すこと。",
    answer_leak: "答えや解き方を言わないこと。わからない後輩として、理由をたずねるだけにすること。",
    out_of_scope_wording: "高校数学の範囲を超える用語を使わないこと。",
    text_topic_mismatch:
      "topic_idを付け替えるのではなく、質問の中身を写真に写っている単元の話に戻すこと。",
    not_a_question: "相づちではなく、質問の形で1つだけたずねること。",
  },
  en: {
    malformed_topic_id:
      "Use a topic_id in the A2-COORD-CIRCLE form, copied exactly from the allowed list.",
    unknown_topic_id: "Only use topic_ids from the allowed list you were given. Do not invent one.",
    topic_not_allowed:
      "Do not bring up a topic that is not in the photo. Ask again within the allowed list.",
    answer_leak:
      "Do not give the answer or the method. You are the one who does not understand — just ask why.",
    out_of_scope_wording: "Do not use terms beyond the high-school syllabus.",
    text_topic_mismatch:
      "Do not swap the topic_id. Bring the question itself back to what is in the photo.",
    not_a_question: "Ask exactly one question. A back-channel reply is not a question.",
  },
};

/** 既定(ロケール未指定)では日本語の説明。 */
export const rejectionGuidance: Record<RejectionReason, string> = rejectionGuidanceByLocale.ja;

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
