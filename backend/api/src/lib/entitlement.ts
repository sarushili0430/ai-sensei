import type { Limits } from "../env.ts";
import type { UserRecord } from "../repository/types.ts";

/**
 * 授業枠の判定。**サーバ側で枠を確保する**(クライアント改竄対策)。
 *
 * Free    : **1日1回・最長10分**(600秒)/ 当日のカルテ閲覧まで
 * Premium : 1回20分(1200秒)/ 1日3600秒の非表示フェアユース上限
 * βテスト : 期間中は全員がPremium相当。持ち時間は `BETA_SECONDS_PER_DAY`
 *           ({@link isBetaOpenAccess})
 *
 * **数えるのは「先輩と話した合計時間」**。`POST /start` でその回の
 * `max_seconds` を仮押さえし、`POST /complete` で実績秒数へ精算する。
 *
 * 無料の「1日1回」は秒数だけでは守れない。5分で切り上げた人には残高が
 * 5分残るので、秒だけを見ていると2本目が始められてしまう。だから
 * **回数の上限も plan で分ける**({@link sessionStartsPerDay})。
 */

export function isPremiumNow(user: UserRecord | null, now: Date): boolean {
  if (!user?.is_premium) return false;
  if (!user.premium_expires_at) return true;
  return new Date(user.premium_expires_at).getTime() > now.getTime();
}

/**
 * クローズドβの開放期間かどうか(`BETA_OPEN_ACCESS_UNTIL`)。
 *
 * この期間、**アプリを入れられるのは限定公開テストの名簿に載っている人だけ**
 * なので、「全員」と「テスター」が同じ集合になる。だから端末IDを集めて
 * 1人ずつ付けて回る必要がなく、機種変更でIDが変わっても付け直しが要らない。
 *
 * 一般公開したらこの前提は崩れる。**期限で自動的に切れる**ようにしてあるのは、
 * 外し忘れたフラグが「なぜか誰も課金画面を見ない」という形でしか
 * 発覚しないため。
 */
export function isBetaOpenAccess(input: { now: Date; limits: Limits }): boolean {
  const until = input.limits.betaOpenAccessUntil;
  return until !== null && input.now.getTime() < until.getTime();
}

/**
 * 機能を解放してよいか。**課金判定を見るところは、すべてこれを通す。**
 *
 * 復習の音声授業・学習プラン・親レポート・あと追い質問・ペイウォールの出し分けが
 * ここに集まっている。β開放を `isPremiumNow` の中に混ぜず1枚上に置いたのは、
 * `isPremiumNow` が**本当に払ったかどうか**を答え続ける必要があるから
 * (webhookの同期とTRANSFERの引き継ぎはそちらを見る)。
 */
export function hasPremiumAccess(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): boolean {
  return isBetaOpenAccess(input) || isPremiumNow(input.user, input.now);
}

export type SessionAllowance =
  | {
      allowed: true;
      maxSeconds: number;
      remainingSecondsToday: number;
      lessonAllowedToday: boolean;
    }
  | {
      allowed: false;
      lessonAllowedToday: false;
      retryAfterSeconds: number;
      reason: "free_limit_reached" | "fair_use_limit_reached";
    };

type SessionLimitInput = {
  remainingSecondsToday: number;
  sessionsToday: number;
  /** その日に始めてよい回数({@link sessionStartsPerDay})。 */
  maxStartsPerDay: number;
};

/** その日に使える会話時間。無料とPremiumの分岐はここだけ。 */
export function secondsPerDay(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  // β開放中は「使い放題」の体感を出すが、上限そのものは外さない。
  // LiveKit・STT・LLM・TTSの従量原価はテスターでも同じだけ動く。
  if (isBetaOpenAccess(input)) return input.limits.betaSecondsPerDay;
  return isPremiumNow(input.user, input.now)
    ? input.limits.premiumSecondsPerDay
    : input.limits.freeSecondsPerDay;
}

/**
 * 授業開始に必要な最低の持ち時間。
 * 3分未満では「教える → 教え返す → 締める」を成立させられない。
 */
export const minimumSessionSeconds = 180;

/**
 * 持ち時間とは別の異常利用ガード(Premium・β開放)。
 * 20回は3分単位で日次枠を切り分けても通常は届かず、開始連打だけを止められる。
 */
export const maxSessionStartsPerDay = 20;

/**
 * 無料の1日の授業本数。**これは隠れたガードではなく、公開している約束**
 * (「無料は1日1回」)なので、上の異常利用ガードとは別の定数にしてある。
 *
 * 秒数(`FREE_SECONDS_PER_DAY`)と二重に効く。秒だけで1回に絞ろうとすると、
 * 途中で切り上げた人に残高が残り、2本目が始められてしまう
 * (`/complete` が実績秒数へ精算するので、5分で降りれば5分戻る)。
 * 逆に回数だけで絞ると、10分の枠を秒で守る側が消える。**両方要る。**
 */
export const freeSessionStartsPerDay = 1;

/** その日に始めてよい授業の本数。無料とPremiumの分岐はここだけ。 */
export function sessionStartsPerDay(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  return hasPremiumAccess(input) ? maxSessionStartsPerDay : freeSessionStartsPerDay;
}

/**
 * 1回の授業に何度まで写真を読み直してよいか。
 *
 * **回数を数える位置を会話の開始へ移したので、解析はこの上限だけが守っている。**
 * 撮り直し・単元の見直し・気が変わってやめる、を余裕で吸収する数にする一方、
 * 解析だけを延々と繰り返してVision LLMの原価を積む使い方はここで止まる。
 *
 * 環境変数にしていないのは、これがユーザーに見せる約束ではないから。
 * なお読み取れなかった写真は行ごと消えるので、この数に入るのは
 * **解析が通ったぶんだけ**。
 */
export const analysesPerSessionSlot = 5;

/** その日に許す写真解析の本数。授業の枠とは別物(理由は上の定数)。 */
export function analysesPerDay(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  // 「授業1本につき解析5回」の幅を、その日に始められる本数から導出する。
  // 秒数と回数の**小さいほう**が本数なので、両方を見る(無料は回数が先に効く)。
  // 1回未満の持ち時間に上書きされても、1本ぶんの解析5回は減らさない。
  const slotsBySeconds = Math.floor(secondsPerDay(input) / sessionMaxSeconds(input));
  const sessionSlots = Math.max(1, Math.min(slotsBySeconds, sessionStartsPerDay(input)));
  return sessionSlots * analysesPerSessionSlot;
}

/**
 * 残高と開始回数から、いま授業を始められるかを判定する。
 *
 * 回数の上限を引数で受けるのは、**無料の「1日1回」とPremiumの連打ガードが
 * 同じ場所で効く**ようにするため({@link sessionStartsPerDay})。
 * ここで定数を直に読むと、片方だけ plan を見る道が2本できる。
 */
export function canStartSessionToday(input: SessionLimitInput): boolean {
  return (
    input.remainingSecondsToday >= minimumSessionSeconds &&
    input.sessionsToday < input.maxStartsPerDay
  );
}

/**
 * 1回の会話の長さ。無料は10分、Premiumは20分。
 *
 * **変わるのは長さだけで、授業の中身は変えない。** 無料でも板書は出るし、
 * 復習問題も作る — 10分で「教える → 教え返す → 締める」が一周するように
 * 先輩の側が畳む(`minimumSessionSeconds` が3分なのはそのため)。
 * 分岐はこの1か所だけにして、機能で無料版を薄くする道を作らない。
 */
export function sessionMaxSeconds(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  return hasPremiumAccess(input)
    ? input.limits.premiumSessionMaxSeconds
    : input.limits.freeSessionMaxSeconds;
}

/**
 * トークンの寿命に足す余白。
 *
 * 会話の上限ちょうどで切れると、締めの数秒で部屋から蹴り出される。
 * **再送を受け付ける窓もこれと同じ**({@link canReissueToken})。
 */
export const tokenGraceSeconds = 120;

/**
 * 始まっているセッションへ、トークンを出し直してよいか。
 * **最初の鍵がまだ生きているあいだだけ**。
 *
 * `started_at` があれば無条件に出し直せると、**部屋に入らないまま開いた
 * セッションを1本持っておく**道ができる。その時間は最初の日に仮押さえされているので、
 * 翌日に鍵だけ出し直せば、今日の残高を減らさずに授業時間が増える
 * (会話が成立しなければ `/complete` も来ないので、行は open のまま残り続ける)。
 *
 * 窓を最初のトークンの寿命に合わせると、再送で救えるのは
 * **同じ会話につなぎ直す場合だけ**になる。それを越えたセッションは、
 * 出し直したところで入る部屋がもう無い。
 */
export function canReissueToken(input: {
  startedAt: string;
  now: Date;
  maxSeconds: number;
}): boolean {
  const elapsedMs = input.now.getTime() - new Date(input.startedAt).getTime();
  // 壊れた `started_at` は NaN になり、この比較は false になる。
  // 読めない値を「まだ生きている」側へ倒さない。
  return elapsedMs <= (input.maxSeconds + tokenGraceSeconds) * 1000;
}

/** 枠を押さえたあとの応答。残高は今回の仮押さえ後。 */
export function startedAllowance(
  input: SessionLimitInput & { maxSeconds: number },
): Extract<SessionAllowance, { allowed: true }> {
  return {
    allowed: true,
    maxSeconds: input.maxSeconds,
    remainingSecondsToday: input.remainingSecondsToday,
    lessonAllowedToday: canStartSessionToday(input),
  };
}

/** 押さえられなかったときの応答(理由と「また明日」までの秒数)。 */
export function limitReachedAllowance(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
  timezoneOffsetMinutes?: number;
}): Extract<SessionAllowance, { allowed: false }> {
  // β開放中のテスターもここでは「解放済み」側。無料枠として返すと、
  // 課金しなくてよいと伝えてある相手にアプリが購入画面を出してしまう。
  const premium = hasPremiumAccess(input);
  return {
    allowed: false,
    lessonAllowedToday: false,
    retryAfterSeconds: secondsUntilLocalMidnight(input.now, input.timezoneOffsetMinutes ?? 540),
    // Premiumを無料枠として扱うと、モバイルが誤って課金導線へ分岐するため理由を分ける。
    reason: premium ? "fair_use_limit_reached" : "free_limit_reached",
  };
}

export function secondsUntilLocalMidnight(now: Date, timezoneOffsetMinutes: number): number {
  const local = new Date(now.getTime() + timezoneOffsetMinutes * 60_000);
  const nextMidnightLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
  );
  return Math.max(0, Math.ceil((nextMidnightLocal - local.getTime()) / 1000));
}

/**
 * ペイウォールを出す位置。**無料で今日の1回を使い切った直後。**
 *
 * 以前は「初回に復習問題ができた回」の1度きりだった。無料が
 * 1日1回・10分になったことで、その回はそのまま**今日の授業が終わった回**に
 * なる — 使い切った瞬間に続きの道を出さないと、生徒は次にできることが
 * 分からないまま画面を閉じることになる。
 *
 * **煽らないという方針は変えていない。** 出るのは日に一度だけで、
 * 会話の途中には割り込まない。締めの画面で「今日はここまで」と言うのと
 * 同じ位置に、続けたい人のための道を1本置くだけ。
 *
 * @see canStartSessionToday — 「今日はもう始められない」の判定はそちら。
 */
export function shouldShowPaywall(input: {
  isPremium: boolean;
  /**
   * この完了のあと、今日まだ授業を始められるか。
   *
   * **応答が返す `limits.lesson_allowed_today` と同じ値を渡すこと。**
   * ここだけ別に数え直すと、画面が「今日はここまで」と言っている横で
   * ペイウォールだけが違う残高を見ている状態が作れてしまう。
   */
  lessonAllowedToday: boolean;
}): boolean {
  // 契約している人に購入画面は出さない。フェアユース上限に当たった日も同じ。
  if (input.isPremium) return false;
  return !input.lessonAllowedToday;
}
