import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { buildPracticeNotification, buildReviewPrompt } from "@ai-sensei/guardrail";

/**
 * 復習プッシュの予約。
 *
 * cronは持たず、OneSignalのスケジュール送信に載せる。
 * 予約IDはD1に残し、穴が埋まったらキャンセルする。
 * 埋めた穴について通知が届くのは、いちばん白ける体験なので。
 */

export type ScheduledNotification = {
  externalId: string | null;
};

export type NotificationScheduler = {
  /** @deprecated 穴ベースの通知。移行が終わるまで残す(ADR 0009)。 */
  schedule(input: {
    deviceId: string;
    holeId: string;
    step: 1 | 2 | 3;
    sendAt: string;
    desc: string;
    daysSince: number;
    /** 穴の文言の言語。呼び出し側が topic_id から引く。 */
    locale?: CurriculumLocale;
  }): Promise<ScheduledNotification>;
  /**
   * 復習問題の通知。
   *
   * **`schedule` と分けたのは、ディープリンクの宛先が違うから。**
   * 穴は `hole_id`、復習問題は `problem_id` を `data` に載せる。同じメソッドで
   * どちらかを渡す形にすると、アプリ側が「どちらが入っているか」を毎回見ることになり、
   * 移行が終わったあとも分岐が残る。
   */
  schedulePractice(input: {
    deviceId: string;
    problemId: string;
    step: 1 | 2 | 3;
    sendAt: string;
    /** 単元名。通知のタイトルで名指しする(「この前の判別式、おぼえてる?」)。 */
    topicLabel: string;
    daysSince: number;
    /** 問題の言語。呼び出し側が topic_id から引く。 */
    locale?: CurriculumLocale;
  }): Promise<ScheduledNotification>;
  cancel(externalId: string): Promise<void>;
};

/**
 * 通知のタイトル。先輩からの声で、アプリ名を叫ばない。
 *
 * **ここがアプリの外で最初に目に入る面**なので、改正後の約束4
 * (「通知もペイウォールも、先輩の判断として書く。数字は見せず、命令や催促にもしない」)
 * が最も試される場所でもある。後輩の「教えてほしい」は**構造的に催促になりようがなかった**が、
 * 先輩は言い切れる立場なので、「リマインド」「忘れていませんか」を入れた瞬間に催促になる。
 * だから**誰が命じるかではなく、届くものの中身で名づける**(英語の `Reminders` も同じ理由で避ける)。
 * 本文({@link buildReviewPrompt})が問いかけなので、タイトルは何が来たかだけを言う。
 */
const headings: Record<CurriculumLocale, string> = {
  ja: "先輩からおさらいです",
  en: "A check-back from your senpai",
};

/** 通知が設定されていない環境(ローカル開発)では何もしない。 */
export const noopScheduler: NotificationScheduler = {
  async schedule() {
    return { externalId: null };
  },
  async schedulePractice() {
    return { externalId: null };
  },
  async cancel() {
    /* noop */
  },
};

export type OneSignalOptions = {
  appId: string;
  restApiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function createOneSignalScheduler(options: OneSignalOptions): NotificationScheduler {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.onesignal.com";

  return {
    async schedule({ deviceId, holeId, step, sendAt, desc, daysSince, locale = "ja" }) {
      const message = buildReviewPrompt({ desc, daysSince, locale });
      // 穴の文言は、そのセッションの課程の言語で書かれている。端末の言語設定で
      // 選び分けると、日本語で説明した穴が英語のタイトルで届くことになるので、
      // **どちらのキーにも同じ(=穴と同じ言語の)文面を入れる**。
      const heading = headings[locale];
      const response = await doFetch(`${baseUrl}/notifications`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Key ${options.restApiKey}`,
        },
        body: JSON.stringify({
          app_id: options.appId,
          // 匿名運用なので、デバイスIDをexternal idにしてある
          include_aliases: { external_id: [deviceId] },
          target_channel: "push",
          // 通知は先輩の声で。タイトルにアプリ名を叫ばせない
          headings: { ja: heading, en: heading },
          contents: { ja: message, en: message },
          send_after: sendAt,
          data: { hole_id: holeId, step },
        }),
      });

      if (!response.ok) {
        throw new Error(`OneSignalの予約に失敗しました: ${response.status}`);
      }
      const payload = (await response.json()) as { id?: string };
      return { externalId: payload.id ?? null };
    },

    async schedulePractice({
      deviceId,
      problemId,
      step,
      sendAt,
      topicLabel,
      daysSince,
      locale = "ja",
    }) {
      const { heading, body } = buildPracticeNotification({ topicLabel, daysSince, locale });
      // 穴の通知と同じ理由で、**どちらのキーにも同じ(= 問題と同じ言語の)文面**を入れる。
      // 端末の言語設定で選び分けると、日本語で教わった単元が英語で届く。
      const response = await doFetch(`${baseUrl}/notifications`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Key ${options.restApiKey}`,
        },
        body: JSON.stringify({
          app_id: options.appId,
          include_aliases: { external_id: [deviceId] },
          target_channel: "push",
          headings: { ja: heading, en: heading },
          contents: { ja: body, en: body },
          send_after: sendAt,
          // **ディープリンクの宛先。**旧通知は `hole_id` を載せていたので、
          // 移行期は両方が飛ぶ。アプリ側はどちらのキーが来ても壊れないこと(#180)。
          data: { problem_id: problemId, step },
        }),
      });

      if (!response.ok) {
        throw new Error(`OneSignalの予約に失敗しました: ${response.status}`);
      }
      const payload = (await response.json()) as { id?: string };
      return { externalId: payload.id ?? null };
    },

    async cancel(externalId) {
      await doFetch(`${baseUrl}/notifications/${externalId}?app_id=${options.appId}`, {
        method: "DELETE",
        headers: { authorization: `Key ${options.restApiKey}` },
      });
    },
  };
}
