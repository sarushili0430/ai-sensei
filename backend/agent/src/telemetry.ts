import type { LogFields } from "./log.ts";

/**
 * **縮退**の監視(計画書 §10-7)。モバイル側の `lib/src/telemetry/telemetry.dart` と対。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【なぜ agent 側に要るのか】穴が非対称だった
 * ─────────────────────────────────────────────────────────────────────────
 *
 * モバイル側は「板書がとぎれた」「式が縮小率の下限を割った」を報告するようになった。
 * だがそれは**受け取り側から見た縮退**で、次の2つは原理的に見えない:
 *
 *   1. **agent が板書を送り損ねた**とき。受け取り側には「来なかった」としか映らず、
 *      送信側で何が起きたか(検証に落ちた・上限で打ち切った・送信が失敗した)は分からない
 *   2. **受け取り側が起動する前**に縮退したとき。生成が始まる前に落ちれば、
 *      報告する主体そのものが存在しない
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【クラッシュと縮退を同じ棚に置かない】
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `JobLogger.error()` は既に `captureException` に流れている。こちらが扱うのは
 * **落ちてはいないが約束が破れている**状態で、`captureMessage(level: "warning")` に送る。
 * クラッシュの棚に混ぜると、本当に落ちたものが埋もれる。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【送らないもの】ユーザーは未成年で、問題文は他者の著作物
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 生徒の発話・transcript・カルテ・**問題文**は送らない。問題文は
 * **R2にすら保存しないと決めたもの**(計画書 §4-1)なので、監視に流れたら
 * 決定そのものが無効になる。
 *
 * **落とし方は許可リスト(deny ではなく allow)。** ログの欄は今後も増えるので、
 * 「危ないものを列挙して落とす」形だと、足された欄が既定で送られてしまう。
 * `board_opened` の `title` のように、**LLMが問題を見て書いた文字列**が
 * 平然と欄に載る場所なので、既定は落とす側でなければならない。
 *
 * ここは Sentry を import しない(テストが SDK を引き込まないように)。
 * 実際の送信は `index.ts` が {@link createDegradationReporter} に差し込む。
 */

/**
 * 監視に上げる縮退。**閉じた集合にする。**
 *
 * `JobLogger.warn` を全部上げると、正常動作の警告(2回目以降の見出しを捨てた・
 * LLMが `index` を数え間違えたが直した)まで飛んで**アラート疲れ**になる。
 * それは #12 で `containsAnswerLeak` を捨てたのと同じ失敗の形で、
 * **本物の異常を見落とす方向にしか働かない。**
 *
 * 入れる基準は「**生徒に届くはずのものが届かなかったか**」の1つだけ。
 */
export const agentDegradations = [
  /** 走査の破綻・封筒の契約違反・送信の失敗。**送信側の縮退そのもの。** */
  "board_append_failed",
  /**
   * 締めの封筒を送れなかった。受信側から見ると板書が開いたままなので、
   * **そのセッションの以降の板書がぜんぶ出なくなる**(`board.ts` の `close` 参照)。
   */
  "board_close_failed",
  /** 検証に落ちた手順が直らなかった。その手順は生徒に届いていない。 */
  "board_step_rejected",
  /** ルートの `}` まで読めなかった。1回ぶんの説明が途中で切れている。 */
  "board_stream_truncated",
  /** 読み切れたのに1手順も無い / 見出しが来ない。契約違反の出力。 */
  "board_lesson_empty",
  "board_head_missing",
  /** 上限で打ち切った。板書1枚(40)と1回の出力(12)。 */
  "board_steps_overflow",
  "board_lesson_overflow",
  /** 閉じた板書に積もうとした。呼び出し側の状態管理がずれている。 */
  "board_append_after_close",
  /** 作り直しが失敗した / JSONですらなかった。 */
  "board_step_repair_failed",
  "board_step_repair_unreadable",
  /**
   * 範囲外の単元で板書を始めようとした(計画書 §8「教える範囲の妥当性」)。
   *
   * **写真に無い話を教えかけた**ということなので、頻発するなら
   * プロンプト側(`senpai_board.*.md` の許可トピックの節)を直す材料になる。
   * 直らなくても授業は続くので、落ちてはいない縮退。
   */
  "board_topics_rejected",
  /** 見出しの作り直しが失敗した / JSONですらなかった。 */
  "board_head_repair_failed",
  "board_head_repair_unreadable",
  /** Text Streams の送り口が無い。**板書がまったく出ない**経路。 */
  "board_publisher_missing",
  /** 古いAPIの復習metadata。対象穴が無いため、板書を出さず従来の会話へ縮退する。 */
  "review_hole_missing",
  /** 授業が1行も板書を出せなかった。**8/16ゲートを見る指標**(計画書 §3-4)。 */
  "lesson_empty",
  /** 読み上げに失敗した。板書は出ているのに音声だけ落ちている。 */
  "say_failed",
] as const;

export type AgentDegradation = (typeof agentDegradations)[number];

const degradationSet = new Set<string>(agentDegradations);

export function isDegradation(event: string): event is AgentDegradation {
  return degradationSet.has(event);
}

/**
 * 監視に送ってよい欄。**ここに無い文字列は落とす。**
 *
 * 判断の材料は「どの板書の、何手順目で、どの種類の失敗が起きたか」で足りる。
 * 詳細(`detail` / `message` / `title`)は**標準出力には残る**ので、
 * 当たりを付けてから `lk agent logs` で引けばよい。
 * 監視に要るのは**気づくこと**で、原因の全文ではない。
 */
export const degradationStringFields = [
  /** ログの見出し。`error` の文脈を送るときに要る。 */
  "event",
  "board_id",
  "session_id",
  "room",
  "job_id",
  /** `latex` / `syntax` / `schema`、`text_in_math` などの列挙。自由文ではない。 */
  "reason",
  "ended_reason",
  "kind",
  "locale",
  "error_name",
] as const;

const allowedStrings = new Set<string>(degradationStringFields);

/**
 * 送る直前に本文を落とす**最後の関門**。
 *
 * 数値・真偽値はそのまま通す(件数・位置・所要時間)。文字列は許可リストのみ。
 * 配列とオブジェクトは中身が読めないので丸ごと落とす。
 */
export function scrubFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string" && allowedStrings.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 同じことを何度も送らないための間引き。モバイル側の `DegradationThrottle` と対。
 *
 * **1回の授業で何十手順も流れる。** 素直に送ると1セッションで大量に飛び、
 * 「1件起きた」と「ずっと起き続けている」の区別がつかなくなる。
 * 板書1枚につき1件送れば、どの板書で起きたかは分かる。
 */
export class DegradationThrottle {
  private readonly limit: number;
  private readonly seen = new Set<string>();

  /**
   * `limit` は覚えておく鍵の上限。**無制限に覚えるとここだけが太り続ける。**
   * 上限に達したら全部忘れる(= そこから先はもう一度だけ送る)。
   * 送りすぎより「長く動いているワーカーからは何も飛ばなくなる」ほうが困る。
   */
  constructor(limit = 64) {
    this.limit = limit;
  }

  allow(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.limit) this.seen.clear();
    this.seen.add(key);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

/**
 * 「同じ出来事」の単位。板書がらみは `board_id` で1枚につき1件。
 * `board_id` を持たない縮退(`board_publisher_missing` など)はセッション単位。
 */
export function degradationKey(event: string, fields: LogFields): string {
  const scope = fields["board_id"] ?? fields["session_id"] ?? "";
  return `${event}/${typeof scope === "string" ? scope : ""}`;
}

/** 実際に送る口。`index.ts` が Sentry を差し込む。 */
export type CaptureDegradation = (event: AgentDegradation, fields: LogFields) => void;

/**
 * `JobLogger.warn` を受けて、縮退だけを間引いて送る関数を作る。
 *
 * **判定・間引き・伏せ字をここに集める。**`log.ts` には「warn が来たら渡す」しか
 * 書かないので、送る条件を変えるときに触る場所が1つで済む。
 */
export function createDegradationReporter(
  capture: CaptureDegradation,
  throttle: DegradationThrottle = new DegradationThrottle(),
): (event: string, fields: LogFields) => void {
  return (event, fields) => {
    if (!isDegradation(event)) return;
    if (!throttle.allow(degradationKey(event, fields))) return;
    capture(event, scrubFields(fields));
  };
}

/* -------------------------------------------------------------------------- */
/* 例外メッセージ                                                              */
/* -------------------------------------------------------------------------- */

/** 例外メッセージを送ってよい長さ。**種類が分かればよく、全文は要らない。** */
export const messageMaxLength = 200;

/**
 * URLは**スキームとホストまで**にする。
 *
 * 秘密が乗るのはパスとクエリ(`?access_token=` / 署名つきURL)なので、
 * そこを落とす。ホストは残す — どのサービスで失敗したかは判断に要る。
 */
const urlPattern = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#]+)[^\s]*/gi;

/**
 * トークンらしい長い塊。JWT・APIキー・base64の断片。
 * 16文字以上の「英数と `-_.` だけの連なり」を潰す。日本語の文と数式は巻き込まない。
 */
const tokenPattern = /\b[A-Za-z0-9_-]{16,}\.?[A-Za-z0-9_-]*\b/g;

/**
 * 例外メッセージから秘密を落とす。
 *
 * **モバイル側が踏んだ罠のサーバ版。**あちらは「LiveKit の例外は `toString()` に
 * 接続先URLやトークンの断片を含むことがある」ことに気づいて `runtimeType` だけにした。
 * こちらは外部SDK(LiveKit / Deepgram / Anthropic)の例外がそのまま
 * `captureException` に載るので、同じものが飛びうる。
 *
 * ただし**種類ごと捨てはしない。**サーバ側はスタックが唯一の手がかりなので、
 * クラス名とスタックは残し、**メッセージの中身だけ**を潰す。
 *
 * 加えて、自前で組み立てたメッセージにAPIの応答本文が入ることがある
 * (`lesson.ts` / `karte.ts` の「失敗しました: <status> <body>」)。
 * 応答本文にはLLMの出力が入りうるので、長さでも切る。
 */
export function scrubMessage(message: string): string {
  const redacted = message.replace(urlPattern, "$1/…").replace(tokenPattern, "…");
  return redacted.length <= messageMaxLength ? redacted : `${redacted.slice(0, messageMaxLength)}…`;
}
