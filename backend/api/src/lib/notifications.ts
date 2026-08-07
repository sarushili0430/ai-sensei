import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { buildReviewPrompt } from "@ai-sensei/guardrail";

/**
 * 復習プッシュの予約。
 *
 * cronは持たず、OneSignalのスケジュール送信に載せる(handoff §5)。
 * 予約IDはD1に残し、穴が埋まったらキャンセルする。
 * 埋めた穴について通知が届くのは、いちばん白ける体験なので。
 */

export type ScheduledNotification = {
  externalId: string | null;
};

export type NotificationScheduler = {
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
  cancel(externalId: string): Promise<void>;
};

/** 通知のタイトル。後輩からの声で、アプリ名を叫ばない。 */
const headings: Record<CurriculumLocale, string> = {
  ja: "後輩から質問です",
  en: "A question from your kohai",
};

/** 通知が設定されていない環境(ローカル開発)では何もしない。 */
export const noopScheduler: NotificationScheduler = {
  async schedule() {
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
          // 通知は後輩の声で。タイトルにアプリ名を叫ばせない
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

    async cancel(externalId) {
      await doFetch(`${baseUrl}/notifications/${externalId}?app_id=${options.appId}`, {
        method: "DELETE",
        headers: { authorization: `Key ${options.restApiKey}` },
      });
    },
  };
}
