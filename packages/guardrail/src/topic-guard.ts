import {
  type Subject,
  type Topic,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  prerequisitesOf,
  subjectsOfTopicIds,
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

/**
 * 許可リストが属する科目。ふつうは1つ(ノート1枚は1科目)。
 * 空なら「まだ決まっていない」、2つ以上なら呼び出し側の組み立てが壊れている。
 */
export function allowedSubjects(allowed: AllowedTopics): Subject[] {
  return subjectsOfTopicIds([...allowed.primary, ...allowed.prerequisite]);
}

export function allowedTopicList(allowed: AllowedTopics): Topic[] {
  return [...allowed.primary, ...allowed.prerequisite]
    .map((id) => findTopic(id))
    .filter((topic): topic is Topic => topic !== undefined);
}

export const rejectionReasons = [
  /** topic_idの形が壊れている。 */
  "malformed_topic_id",
  /** 形は正しいがカリキュラムマップにない(大学数学・言語学・他教科など)。 */
  "unknown_topic_id",
  /** カリキュラム内だが、この写真の許可リストに入っていない。 */
  "topic_not_allowed",
  /** 質問文が答えを与えてしまっている。 */
  "answer_leak",
  /** 高校の範囲外を示す語が本文に入っている。 */
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
 * 高校の範囲の外側を指す語。写真にたまたま大学範囲のメモが写っていても、
 * 後輩がそこに食いつかないようにする。
 *
 * 科目ごとに分けて持つが、照合は**まとめて**行う。数学のセッションに
 * 「生成文法」が出てくるのも、英文法のセッションに「固有値」が出てくるのも、
 * どちらも同じく範囲外だから。
 */
export const outOfScopeTermsBySubject: Record<Subject, string[]> = {
  数学: [
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
  英文法: [
    "生成文法",
    "変形文法",
    "統語論",
    "音韻論",
    "形態論",
    "語用論",
    "意味論",
    "認知言語学",
    "格文法",
    "深層構造",
    "表層構造",
    "ミニマリスト・プログラム",
    "普遍文法",
    "選択制限",
    "統語構造",
  ],
};

export const outOfScopeTerms = Object.values(outOfScopeTermsBySubject).flat();

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
  // 確認の形をした答え。「x=2ですよね?」「2点で交わるんですよね?」は
  // 疑問符が付いていても中身は答えそのものなので、質問として通してはいけない。
  /[=＝][^。?？]{0,12}(?:です|でしょ)(?:よね|ね)?[?？]/,
  /(?:答え|解|値|個数|最大値|最小値|範囲)\s*(?:は|が)[^。?？]{0,20}(?:です|になり)(?:ます)?(?:よね|ね)?[?？]/,
  /\d[^。?？]{0,12}(?:ですよね|んですよね|になりますよね)[?？]/,
  /(?:交わる|接する|成り立つ|同じ|等しい)(?:ん)?ですよね[?？]/,
  // 英文法版の「確認の形をした答え」。文法用語を言い当ててしまうと、
  // ユーザーが自分で気づく余地がなくなる(「ここ、現在完了ですよね?」)。
  /(?:現在完了|過去完了|受動態|分詞構文|仮定法過去|関係代名詞|関係副詞|原形不定詞|動名詞|比較級|最上級|間接疑問|強調構文|倒置)(?:の[^。?？]{0,8})?(?:ん)?ですよね[?？]/,
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
 *
 * 推定はセッションの科目の中だけで行う。科目をまたいで推定すると、
 * 「比較」「否定」「省略」のような**どちらの科目にもある日本語**で
 * 取り違えが起きて、まっとうな質問(数学の「なんで比較して判定したんですか?」)が
 * 英文法の比較表現と見なされて落ちてしまう。科目の取り違えそのものは
 * topic_id の照合(`topic_not_allowed`)が先に弾く。
 */
export function mentionsOnlyDisallowedTopics(text: string, allowed: AllowedTopics): boolean {
  const subjects = allowedSubjects(allowed);
  const candidates =
    subjects.length === 1 && subjects[0] !== undefined
      ? suggestTopics(text, 3, { subject: subjects[0] })
      : suggestTopics(text, 3);
  if (candidates.length === 0) return false;
  return candidates.every((topic) => !isAllowedTopic(allowed, topic.id));
}

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
      detail: `高校の範囲外の語: ${outOfScope}`,
    };
  }
  if (containsAnswerLeak(question.text)) {
    return { ok: false, reason: "answer_leak", detail: "質問が答えを与えてしまっています" };
  }
  if (mentionsOnlyDisallowedTopics(question.text, allowed)) {
    return {
      ok: false,
      reason: "text_topic_mismatch",
      detail: "topic_idは許可内ですが、質問文が写真にない単元の話になっています",
    };
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
  out_of_scope_wording: "高校の範囲を超える用語(大学数学・言語学など)を使わないこと。",
  text_topic_mismatch:
    "topic_idを付け替えるのではなく、質問の中身を写真に写っている単元の話に戻すこと。",
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
