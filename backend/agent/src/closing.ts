/**
 * 会話が自然に終わったことの検出。
 *
 * 会話プロンプトは「今日はここまでにしよっか」または
 * "Let's stop here for today" で終えると指示している。その締めの発話を見て
 * `completed` として閉じる。
 *
 * これがないと、うまく終わった会話でも上限時間(最長5分)まで部屋が空回りし、
 * ended_reason に `completed` が一度も立たない。
 *
 * 文言パターンは `senpai.ts` の `handsTurnToStudent` と同じく、プロンプト変更時に
 * 同期漏れを起こす構造的な脆さを持つ。将来は `end_session` のようなツールを
 * LLM に呼ばせる案があるが、文言合わせの効果を切り分けるため今回は実装しない。
 */

/**
 * 「ここまで」が**今日の授業ぜんぶ**を指していることの裏付け。
 *
 * レビュー指摘: 「ここまで」は説明の区切りにも使う。「説明はここまでかな?じゃあ次は」を
 * 締めと取り違えると、**授業の途中で部屋が閉じる** — 検出できないより悪い壊れ方になる。
 * 「今日は」「そろそろ」のような、今日ぜんぶを指す語を前に要求して切り分ける。
 *
 * 逆に取りこぼしたとき(「じゃあここまでにしよっか」)は上限時間まで空回りするだけなので、
 * **見逃す側に倒している。** プロンプトは「今日はここまでにしよっか」と明示する指示に
 * してあり(`prompts/senpai_conversation.ja.md` の「締め方」)、その形を受ける。
 *
 * 句点をまたがせないのは、前の文の「今日」を裏付けに使わせないため
 * (「今日は二次関数やったね。説明はここまでかな?」は締めではない)。
 */
const SESSION_SCOPE = String.raw`(?:今日|きょう|本日|そろそろ)[^。！!?？\n]{0,8}`;

/** 語の途中で切らないための後続アンカー(「ここまでかなり進んだね」を締めにしない)。 */
const SENTENCE_TAIL = String.raw`(?:[。、！!?？,]|\s|$)`;

const CLOSING_PATTERNS: RegExp[] = [
  // 終止の形だけで「今日はここまでいい?」を除外できるため、後続アンカーは置かない。
  new RegExp(`${SESSION_SCOPE}ここまでにし(?:よ(?:う|っか)|とこ(?:う|っか))`),
  new RegExp(`${SESSION_SCOPE}ここまでかな${SENTENCE_TAIL}`),
  new RegExp(
    String.raw`(?:また\s*)?(?:来たとき|今度)[、,]?\s*この続きやろ(?:う|っか)${SENTENCE_TAIL}`,
  ),
  /let['’]s stop here for today\b/i,
  /next time you['’]re here, let['’]s pick this up\b/i,
];

/** AI側の締めの発話かどうか。ユーザー側の発話には使わない。 */
export function isClosingUtterance(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  return CLOSING_PATTERNS.some((pattern) => pattern.test(normalized));
}
