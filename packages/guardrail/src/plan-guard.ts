import {
  type CurriculumLocale,
  isKnownTopicId,
  isWellFormedTopicId,
  localeOfTopicId,
} from "@ai-sensei/curriculum";
import { type AllowedTopics, buildAllowedTopics, isAllowedTopic } from "./topic-guard.ts";

/**
 * 学習計画の単元照合(二重ガードの2枚目・計画版)。
 *
 * `@ai-sensei/contract` の `plan.ts` は依存を持たない層なので、**前提関係を知らない**。
 * 結果として「テスト範囲は三角関数」と聞き取った計画に「ベクトルを2時間」という日が
 * 入っていても、スキーマは通り、画面にも出る。ここがその穴を塞ぐ
 * (`topic-guard.ts` が板書とカルテにやっていることと同じ構え)。
 *
 * **範囲と割り当てで、落とし方をわざと変えている。**
 *
 *   - **範囲({@link checkPlanScope})は1つでも壊れていたら全体を落とす。**
 *     範囲は「テストに何が出るか」という聞き取った事実で、黙って1単元を捨てると
 *     **実際より狭いテストに向けた計画**ができあがる。生徒は範囲の一部を勉強しないまま
 *     当日を迎えることになり、しかもそれに気づく手段がない。
 *   - **割り当て({@link filterPlanItems})は1件ずつ落とす。**
 *     こちらは生成物なので、1日が範囲外でも残りの日は使える。
 *     `filterHoleTopicIds()` がカルテの穴を1件ずつ落とすのと同じ考え方。
 */

/**
 * 計画で「範囲の前提」としてどこまで遡ってよいか。
 *
 * **いまは会話側(`topic-guard.ts` の `conversationPrerequisiteDepth`)と同じ2段。**
 * それでも別の定数にしてあるのは、**同じ値に見えて別の判断だから** —
 * 会話側は原価(セッション時間)の都合で浅くしたくなることがあり、
 * そのときに計画まで黙って追随すると、正当な復習日が範囲外として落ちはじめる。
 *
 * **当初は「計画のほうが深いはず」と考えていた**(会話の単位は質問、計画の単位は1日で、
 * 前提の復習に1日使うのは家庭教師のふつうの組み方だから)。実際に測ってみると、
 * **深さを決めているのは仕事の単位ではなくカリキュラムの形のほう**だった:
 *
 *   | 深さ | 1トピックあたり増えるトピック数(平均 / 最大) |
 *   | --- | --- |
 *   | 1段 | 0.98 / 4(ja)・1.05 / 3(en) |
 *   | **2段** | **1.85 / 8(ja)・2.07 / 7(en)** |
 *   | 3段 | 2.37 / 11(ja)・2.91 / 10(en) |
 *
 * 前提の連鎖はいちばん長いもので5段しかなく、**2段で飽和する**(3段目以降で増えるのは
 * 平均0.5件ほど)。つまり3段にしても「もう1日ぶんの復習」が増えるわけではなく、
 * 遠い単元がぽつぽつ入るだけになる。
 *
 * 一方で前提の辺は**学習の順序に沿って伸びる**ので、2段広げても別の系列
 * (三角関数の計画にベクトル)には届かない — 広げても安全な側は測って確かめてある。
 *
 * これより深くすると、計画は「テスト対策」ではなく「課程のやり直し」になる。
 * テストまでに終わらない計画は守られず、守られない計画は
 * 「計画は自分には無理だ」だけを教える(`contract` の `planDayMinutesMax` と同じ理由)。
 */
export const planPrerequisiteDepth = 2;

export const planRejectionReasons = [
  /** topic_idの形が壊れている。 */
  "malformed_topic_id",
  /** 形は正しいがカリキュラムマップにない(捏造)。 */
  "unknown_topic_id",
  /** 範囲に日本の課程と海外の課程が混ざっている。 */
  "mixed_curricula",
  /** 範囲が空になった(照合できるIDが1つもない)。 */
  "empty_scope",
  /** カリキュラム内だが、範囲でもその前提でもない単元を割り当てている。 */
  "topic_out_of_scope",
] as const;
export type PlanRejectionReason = (typeof planRejectionReasons)[number];

export type PlanScopeVerdict =
  | { ok: true; allowed: AllowedTopics }
  | { ok: false; reason: PlanRejectionReason; detail: string };

export type BuildPlanTopicsOptions = {
  /** 前提を何段たどるか。既定は {@link planPrerequisiteDepth}。 */
  prerequisiteDepth?: number;
};

/**
 * 聞き取った範囲を検査し、通れば「計画に置いてよい単元」の集合を返す。
 *
 * **1つでも通らなければ全体を落とす**(理由はファイル冒頭)。
 * 落ちたら agent は範囲を聞き直すか、許可トピックを添えて作り直させる。
 * 黙って狭い範囲で計画を作らせてはいけない。
 */
export function checkPlanScope(
  scopeTopicIds: readonly string[],
  options: BuildPlanTopicsOptions = {},
): PlanScopeVerdict {
  if (scopeTopicIds.length === 0) {
    return { ok: false, reason: "empty_scope", detail: "テスト範囲の単元が1つもありません" };
  }

  for (const topicId of scopeTopicIds) {
    if (!isWellFormedTopicId(topicId)) {
      return {
        ok: false,
        reason: "malformed_topic_id",
        detail: `topic_idの形式が不正: ${topicId}`,
      };
    }
    if (!isKnownTopicId(topicId)) {
      return {
        ok: false,
        reason: "unknown_topic_id",
        detail: `カリキュラムマップにないtopic_id: ${topicId}`,
      };
    }
  }

  /**
   * 課程の混在。**計画でだけ見る。**
   *
   * 1つの計画は1つのテストのためのもので、日本の課程と海外の課程が同じ範囲に
   * 並ぶことはない。混ざっているのは、LLMが両方のカリキュラムの記憶から
   * 引いてきたということで、**範囲の残りも信用できない**。
   * `allowedTopicsLocale()` は最初に見つかった課程を返すので、ここで弾かないと
   * 「英語の計画に日本語の単元名が1つ混ざる」形で静かに残る。
   */
  const locales = new Set<CurriculumLocale>();
  for (const topicId of scopeTopicIds) {
    const locale = localeOfTopicId(topicId);
    if (locale) locales.add(locale);
  }
  if (locales.size > 1) {
    return {
      ok: false,
      reason: "mixed_curricula",
      detail: `1つの計画に複数の課程が混ざっています: ${[...locales].join(", ")}`,
    };
  }

  const allowed = buildAllowedTopics(scopeTopicIds, {
    prerequisiteDepth: options.prerequisiteDepth ?? planPrerequisiteDepth,
  });
  // 形も存在も確かめた後なので、ここが空になるのは呼び出し方が壊れているとき。
  if (allowed.primary.size === 0) {
    return { ok: false, reason: "empty_scope", detail: "テスト範囲の単元が1つもありません" };
  }

  return { ok: true, allowed };
}

export type PlanItemRejection<T> = {
  item: T;
  reason: PlanRejectionReason;
  detail: string;
};

export type PlanItemFilterResult<T> = {
  accepted: T[];
  rejected: PlanItemRejection<T>[];
};

/**
 * 日ごとの割り当てを1件ずつ検査する。
 *
 * `allowed` は {@link checkPlanScope} が返したもの。**範囲そのものの検査を
 * 飛ばしてここだけ呼ばないこと** — 範囲が捏造されていると、その前提から作った
 * 許可集合も捏造の上に立つので、「範囲内です」という判定に意味がなくなる。
 *
 * 型引数にしてあるのは、`contract` の `PlanItem` をそのまま渡せるようにするため。
 * guardrail は contract に依存しない層なので、`topic_id` を持つことだけを要求する
 * (`filterHoleTopicIds` と同じ書き方)。
 */
export function filterPlanItems<T extends { topic_id: string }>(
  items: readonly T[],
  allowed: AllowedTopics,
): PlanItemFilterResult<T> {
  const result: PlanItemFilterResult<T> = { accepted: [], rejected: [] };

  for (const item of items) {
    if (!isWellFormedTopicId(item.topic_id)) {
      result.rejected.push({
        item,
        reason: "malformed_topic_id",
        detail: `topic_idの形式が不正: ${item.topic_id}`,
      });
    } else if (!isKnownTopicId(item.topic_id)) {
      result.rejected.push({
        item,
        reason: "unknown_topic_id",
        detail: `カリキュラムマップにないtopic_id: ${item.topic_id}`,
      });
    } else if (!isAllowedTopic(allowed, item.topic_id)) {
      result.rejected.push({
        item,
        reason: "topic_out_of_scope",
        detail: `テスト範囲にもその前提にもない単元: ${item.topic_id}`,
      });
    } else {
      result.accepted.push(item);
    }
  }

  return result;
}

/**
 * 再生成プロンプトに添える指示。**会話の言語で書く**
 * (`topic-guard.ts` / `latex-guard.ts` と同じ理由 — 日本語の指示を英語の会話に
 * 混ぜると、次の計画だけ日本語で返ってくる)。
 *
 * **どの指示も「聞き直す」か「範囲の中で組み直す」に行き先を揃えてある。**
 * 「範囲外です」だけを返すと、LLMは範囲(`intake.scope.topic_ids`)のほうを
 * 書き換えて辻褄を合わせにいく — それは**聞き取った事実の改竄**で、
 * 計画が通っても生徒のテスト範囲とは別物になる。
 */
export const planRejectionGuidanceByLocale: Record<
  CurriculumLocale,
  Record<PlanRejectionReason, string>
> = {
  ja: {
    malformed_topic_id:
      "topic_idは M2-SANKAKU-KAHO の形式で、許可リストからそのまま選ぶこと。作らないこと。",
    unknown_topic_id: "topic_idは渡された許可リストにあるものだけを使うこと。新しく作らないこと。",
    mixed_curricula:
      "1つの計画に複数の課程を混ぜないこと。生徒が言った範囲の課程だけで単元を選ぶこと。",
    empty_scope:
      "テスト範囲の単元が特定できていません。範囲を作らずに、生徒に「範囲は?」と聞き直すこと。",
    topic_out_of_scope:
      "テスト範囲(とその前提)の外の単元を計画に入れないこと。**範囲のほうを書き換えず**、その日の割り当てを範囲内の単元に差し替えること。",
  },
  en: {
    malformed_topic_id:
      "Use a topic_id in the PC-TRIG-IDENTITY form, copied exactly from the allowed list. Never invent one.",
    unknown_topic_id: "Only use topic_ids from the allowed list you were given. Do not invent one.",
    mixed_curricula:
      "Do not mix curricula in one plan. Pick topics from the one course sequence the student described.",
    empty_scope:
      "The topics on the test are not identified. Do not build a plan — ask the student what the test covers.",
    topic_out_of_scope:
      "Do not put topics outside the test range (or its prerequisites) into the plan. **Do not rewrite the range** — replace that day's work with a topic inside it.",
  },
};

/** 既定(ロケール未指定)では日本語の説明。 */
export const planRejectionGuidance: Record<PlanRejectionReason, string> =
  planRejectionGuidanceByLocale.ja;
