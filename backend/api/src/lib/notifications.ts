import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { buildReviewPrompt } from "@ai-sensei/guardrail";

/**
 * Booking review pushes.
 *
 * There is no cron; it rides OneSignal's scheduled send. The booking id is kept
 * in D1 and cancelled once the hole is filled - a notification about a hole you
 * already filled is the most deflating thing there is.
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
    /** The hole wording's language. The caller derives it from topic_id. */
    locale?: CurriculumLocale;
  }): Promise<ScheduledNotification>;
  cancel(externalId: string): Promise<void>;
};

/**
 * The notification title. It is the senpai's voice; it does not shout the app name.
 *
 * This is the first surface seen outside the app, so it is where post-revision
 * promise 4 ("notifications and paywalls are written as the senpai's judgement:
 * no numbers, no orders, no nagging") is tested most. The old kouhai's "teach
 * me" could not structurally become nagging, but the senpai speaks with
 * authority, so "reminder" or "haven't you forgotten?" becomes nagging on the
 * spot. So it is named by what arrives, not by who is telling whom (the English
 * `Reminders` is avoided for the same reason). The body
 * ({@link buildReviewPrompt}) asks the question, so the title only says what came.
 */
const headings: Record<CurriculumLocale, string> = {
  ja: "先輩からおさらいです",
  en: "A check-back from your senpai",
};

/** Does nothing in environments with no notification config (local development). */
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
      // A hole's wording is written in that session's curriculum language. Choosing
      // by the device's language setting would deliver a hole explained in Japanese
      // under an English title, so both keys get the same text (the hole's language).
      const heading = headings[locale];
      const response = await doFetch(`${baseUrl}/notifications`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Key ${options.restApiKey}`,
        },
        body: JSON.stringify({
          app_id: options.appId,
          // Anonymous operation, so the device id is the external id
          include_aliases: { external_id: [deviceId] },
          target_channel: "push",
          // Notifications speak in the senpai's voice; the title never shouts the app name
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
