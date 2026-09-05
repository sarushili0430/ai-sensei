import type { CurriculumLocale } from "@ai-sensei/curriculum";

/**
 * 間隔反復スケジューラ(翌日 → 3日後 → 7日後)。
 *
 * OneSignal賞の中核であり、後付けの機能ではなく製品そのもの。
 * 通知は「リマインダー」ではなく **後輩からのお願い** として書く。
 * 罪悪感で煽る文面(「記録が途切れます」等)は作らない。
 */

/** 各段の日数。 */
export const reviewStepDays = [1, 3, 7] as const;
export type ReviewStep = 1 | 2 | 3;

export type ScheduleOptions = {
  /** ローカルタイムゾーンのUTCオフセット(分)。日本の高校生向けなので既定はJST。 */
  timezoneOffsetMinutes?: number;
  /** 通知するローカル時刻。夜の勉強時間帯に置く。 */
  hourLocal?: number;
  minuteLocal?: number;
};

const DEFAULTS = { timezoneOffsetMinutes: 540, hourLocal: 20, minuteLocal: 0 } as const;

export type ScheduledReview = {
  hole_id: string;
  step: ReviewStep;
  scheduled_at: string;
};

/**
 * セッション完了時に、その日できた穴の再説明を3段階で予約する。
 * 予約はサーバ側で作り、OneSignalのスケジュール送信に載せる(cronは持たない)。
 */
export function scheduleReviews(
  holeIds: readonly string[],
  completedAt: Date,
  options: ScheduleOptions = {},
): ScheduledReview[] {
  const entries: ScheduledReview[] = [];
  for (const holeId of holeIds) {
    reviewStepDays.forEach((days, index) => {
      entries.push({
        hole_id: holeId,
        step: (index + 1) as ReviewStep,
        scheduled_at: reviewTimeAfterDays(completedAt, days, options).toISOString(),
      });
    });
  }
  return entries;
}

/**
 * 復習問題の通知を、どの段で予約するか(ADR 0009)。
 *
 * **段を詰めない。**正解は「step 1 を落とす」であって「3日後を step 1 にする」では
 * ありません。詰めると `nextReviewStep` の意味と `reviewStepDays` の対応が壊れ、
 * 「step 2 = 3日後」という前提を持っている経路(既存の通知・D1のCHECK制約)が
 * 静かにずれます。
 *
 * | verdict | 段 | 日 |
 * | --- | --- | --- |
 * | `incorrect` | 1・2・3 | 翌日・3日後・7日後 |
 * | `correct` | 2・3 | 3日後・7日後 |
 * | `unclear` | なし | 予約しない(解き直しを待つ) |
 *
 * 正解でも予約するのは、「1回言えたら終わり」に戻さないため。
 * `unclear` で予約しないのは、**採点側が読めなかっただけ**で、
 * 生徒の理解について何も観測できていないから。
 */
export const practiceStepsByVerdict = {
  incorrect: [1, 2, 3],
  correct: [2, 3],
  unclear: [],
} as const satisfies Record<string, readonly ReviewStep[]>;

/**
 * セッション完了時(= 「わかった」を押した直後)に予約する段。
 *
 * **翌日は置かない。**押したのは到達の宣言なので、`correct` と同じ扱いにする。
 * 押した翌日に「まちがえた問題」と同じ間隔で届くと、押したことが罰になる。
 */
export const practiceStepsOnCreate: readonly ReviewStep[] = practiceStepsByVerdict.correct;

export type ScheduledPractice = {
  problem_id: string;
  step: ReviewStep;
  /** 起点から何日後か。画面の「つぎは 明日・3日後・7日後にきくね」を組む。 */
  days: number;
  scheduled_at: string;
};

/**
 * 復習問題の通知を予約する。
 *
 * **取り消す口は作らない。**作成時に決めた段は取り消さない(ADR 0009)ので、
 * ここは常に「足す」だけ。3日目に正解したから7日目を消す、をやると
 * 「1回言えたら終わり」に戻り、間隔反復の効き目が消える。
 */
export function schedulePractice(
  problemIds: readonly string[],
  at: Date,
  steps: readonly ReviewStep[],
  options: ScheduleOptions = {},
): ScheduledPractice[] {
  const entries: ScheduledPractice[] = [];
  for (const problemId of problemIds) {
    for (const step of steps) {
      const days = reviewStepDays[step - 1];
      if (days === undefined) continue;
      entries.push({
        problem_id: problemId,
        step,
        days,
        scheduled_at: reviewTimeAfterDays(at, days, options).toISOString(),
      });
    }
  }
  return entries;
}

/** completedAt のローカル日付から days 日後の、指定ローカル時刻のUTC時刻。 */
export function reviewTimeAfterDays(
  completedAt: Date,
  days: number,
  options: ScheduleOptions = {},
): Date {
  const offsetMinutes = options.timezoneOffsetMinutes ?? DEFAULTS.timezoneOffsetMinutes;
  const hour = options.hourLocal ?? DEFAULTS.hourLocal;
  const minute = options.minuteLocal ?? DEFAULTS.minuteLocal;

  const local = new Date(completedAt.getTime() + offsetMinutes * 60_000);
  const localTargetMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + days,
    hour,
    minute,
  );
  return new Date(localTargetMs - offsetMinutes * 60_000);
}

/** 再説明で埋まらなかったときに次の段へ進める。3段目まで行ったら打ち切る。 */
export function nextReviewStep(current: ReviewStep): ReviewStep | null {
  return current < 3 ? ((current + 1) as ReviewStep) : null;
}

/**
 * 遅延したときに落とす順(ソロ運用ルール)。
 * 3段階 → 翌日のみ、に縮小するためのフラグ。
 */
export function activeStepDays(reduced = false): readonly number[] {
  return reduced ? [reviewStepDays[0]] : reviewStepDays;
}

export type ReviewPromptInput = {
  /** 穴の説明。「判別式を『なぜ』使うのか、で説明が止まった」 */
  desc: string;
  /** 何日前にできた穴か。 */
  daysSince: number;
  /**
   * 文面の言語。省略時は日本語。
   *
   * 呼び出し側は穴の topic_id から引く(`localeOfTopicId`)。穴の説明文は
   * その課程の言語で書かれているので、言語を取り違えると
   * 「きのうの『why the discriminant is used』」のような通知になる。
   */
  locale?: CurriculumLocale;
};

/**
 * 通知文とレビュー画面の一行を作る。
 * 後輩の声・お願いの形。責める語彙と記録を人質に取る表現は使わない。
 */
export function buildReviewPrompt({ desc, daysSince, locale = "ja" }: ReviewPromptInput): string {
  if (locale === "en") {
    const when =
      daysSince <= 0 ? "earlier today" : daysSince === 1 ? "yesterday" : `${daysSince} days ago`;
    return `That "${toSubject(desc, locale)}" from ${when} — could you explain it to me now?`;
  }
  const when = daysSince <= 0 ? "さっき" : daysSince === 1 ? "きのう" : `${daysSince}日前`;
  return `${when}の「${toSubject(desc, locale)}」、いまなら説明できますか?`;
}

export type PracticeNotificationInput = {
  /** 単元名(「判別式と解の個数」)。呼び出し側が `topic_id` から引く。 */
  topicLabel: string;
  /** 問題ができてから何日たったか。 */
  daysSince: number;
  locale?: CurriculumLocale;
};

/**
 * 復習問題の通知の、見出しと本文。
 *
 * **タイトルで単元を名指しする。**穴の通知(`headings` の「先輩からおさらいです」)は
 * 「何が来たか」だけを言う形だったが、復習問題は**開いたら30秒で終わる1問**なので、
 * ロック画面の時点で「何を思い出す時間か」が分かるほうが開きやすい。
 * 問いかけの形にしてあるのは、催促にしないため(約束4)— 「忘れていませんか」
 * 「記録が途切れます」は書かない。
 *
 * **本文で「1問」「30秒」を言う。**通知から開いた先が長いと分かった時点で、
 * その通知は二度と開かれなくなる。短さは煽り文句ではなく事実の申告。
 */
export function buildPracticeNotification({
  topicLabel,
  daysSince,
  locale = "ja",
}: PracticeNotificationInput): { heading: string; body: string } {
  if (locale === "en") {
    const when = daysSince <= 1 ? "the other day" : `${daysSince} days ago`;
    return {
      heading: `That ${topicLabel} from ${when} — still with you?`,
      body: "Just one question. Takes about 30 seconds.",
    };
  }
  const when = daysSince <= 1 ? "この前" : `${daysSince}日前`;
  return {
    heading: `${when}の${topicLabel}、おぼえてる?`,
    body: "1問だけ置いておくね。30秒で終わるやつ。",
  };
}

/** 穴の説明文から、通知に載る短い主題を取り出す。 */
function toSubject(desc: string, locale: CurriculumLocale): string {
  const trimmed =
    locale === "en"
      ? desc
          .replace(/^the explanation stopped at\s+/iu, "")
          .replace(/^(?:you )?stopped at\s+/iu, "")
          .replace(/[,]?\s*(?:—|-)?\s*(?:where )?the explanation stopped\.?$/iu, "")
          .replace(/^["“]|["”]$/gu, "")
          .trim()
      : desc
          .replace(/[、,]?\s*で説明が止まった。?$/u, "")
          .replace(/[、,]?\s*説明できなかった。?$/u, "")
          .replace(/^「|」$/gu, "")
          .trim();

  const subject = trimmed.length > 0 ? trimmed : desc.trim();
  // 英語は1文字あたりの情報量が少ないので、同じ見た目の長さに収まるまで長く取る。
  const limit = locale === "en" ? 48 : 24;
  return subject.length <= limit ? subject : `${subject.slice(0, limit - 1)}…`;
}
