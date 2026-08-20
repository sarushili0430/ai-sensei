import { promptSources } from "./generated.ts";
import {
  type PromptLocale,
  type PromptTemplate,
  parsePrompt,
  promptLocales,
  renderPrompt,
} from "./render.ts";
export * from "./render.ts";

export const promptIds = [
  "photo_analysis",
  "senpai_conversation",
  "question_types_few_shot",
  "karte_generation",
  "math_speech_hints",
  "english_speech_hints",
  "senpai_board",
  "senpai_board_english",
  "study_plan",
] as const;
export type PromptId = (typeof promptIds)[number];

/**
 * どのプロンプトが、どの言語で用意されているか。**ここが正**。
 *
 * ほとんどのプロンプトは日英2本ずつだが、教科に紐づくものはそうならない。
 * `english_speech_hints` は「**日本語話者が英語を話すときの**STTの癖」を書いた
 * ものなので、英語で教える課程には存在しない(英語話者に英語を教える課程を
 * このアプリは持たない)。
 *
 * ファイル数の検査もここを基準にする。`promptIds.length * promptLocales.length`
 * で数えると、教科別のプロンプトを足した瞬間に「揃っていない」と誤検知する。
 */
export const promptCatalog: Record<PromptId, readonly PromptLocale[]> = {
  photo_analysis: promptLocales,
  senpai_conversation: promptLocales,
  question_types_few_shot: promptLocales,
  karte_generation: promptLocales,
  math_speech_hints: promptLocales,
  english_speech_hints: ["ja"],
  senpai_board: promptLocales,
  senpai_board_english: ["ja"],
  study_plan: promptLocales,
};

/** 既定のロケール。未対応の言語で来た場合もここに落ちる。 */
export const defaultPromptLocale: PromptLocale = "ja";

const templates = new Map<string, PromptTemplate>();
for (const source of Object.values(promptSources)) {
  const template = parsePrompt(source);
  templates.set(keyOf(template.meta.id, template.meta.locale), template);
}

function keyOf(id: string, locale: string): string {
  return `${id}:${locale}`;
}

/**
 * プロンプトを1本取り出す。
 *
 * 言語ごとに**別のファイル**を持つ(`prompts/<id>.<locale>.md`)。
 * 日本語のプロンプトの末尾に「英語で答えて」と足す作りにすると、
 * ペルソナも禁止事項も日本語のまま英語で薄く言い直されるだけになる。
 *
 * **無い組み合わせは既定の言語に落とさず、落とす。** 未知の言語を丸めるのは
 * {@link toPromptLocale} の仕事で、ここに来る `locale` は必ず `promptLocales` の
 * どれか。それでも見つからないなら「その id にその言語版は無い」ということで、
 * 黙って日本語版を返すと**英語のセッションで先輩が日本語を喋り出す**。
 * 言語を1つ増やすときは {@link promptCatalog} に宣言を足す。
 */
export function getPrompt(
  id: PromptId,
  locale: PromptLocale = defaultPromptLocale,
): PromptTemplate {
  const template = templates.get(keyOf(id, locale));
  if (template) return template;
  throw new Error(
    `プロンプトがありません: ${id} (${locale})。このidは ${promptCatalog[id].join(" / ")} にだけあります`,
  );
}

/** 全ロケールぶん。設計上の約束が書かれているかの検査に使う。 */
export function allPrompts(): PromptTemplate[] {
  return [...templates.values()];
}

/** そのロケールで用意されているプロンプト全部。 */
export function promptsFor(locale: PromptLocale): PromptTemplate[] {
  return promptIds
    .filter((id) => promptCatalog[id].includes(locale))
    .map((id) => getPrompt(id, locale));
}

/**
 * 授業の教科。
 *
 * **`@ai-sensei/curriculum` の `CurriculumSubject` と同じ値にすること。**
 * このパッケージは依存を持たない層(`formatAllowedTopics` がトピックを
 * 構造的に受けているのと同じ理由)なので参照できず、二重に書いている。
 */
export const promptSubjects = ["math", "english"] as const;
export type PromptSubject = (typeof promptSubjects)[number];

/**
 * 教科ごとの音声補正ヒント。
 *
 * **教科で必ず切り替える。** 数学版の「さんぶんのに = 2/3」「にじょう = ^2」を
 * 英語の授業に当てると、生徒の発話を数式として読み直してしまう。逆に英語版の
 * 「冠詞の脱落は言えていない証拠にしない」を数学に当てても効かない。
 */
function speechHintsId(subject: PromptSubject): PromptId {
  return subject === "math" ? "math_speech_hints" : "english_speech_hints";
}

/** 教科ごとの板書プロンプト。使える要素も、守らせる規約も重ならない。 */
function boardPromptId(subject: PromptSubject): PromptId {
  return subject === "math" ? "senpai_board" : "senpai_board_english";
}

/** システムプロンプトを組むときの授業の文脈。 */
export type PromptContext = {
  locale?: PromptLocale;
  /** 授業の教科。`subjectOfTopicId(topic_id)` で引ける(ADR 0007)。 */
  subject: PromptSubject;
};

/**
 * 教え返しを聞く先輩のシステムプロンプト(ピボット計画 v1 §2 のコアループ2つ目)。
 *
 * few-shotと音声補正ヒントを常に同梱する。3つを別々に渡すと
 * 「片方だけ更新される」事故が起きるので、1本にまとめて返す。
 *
 * **`lesson_recap` は必須**(渡し忘れは `renderPrompt` が落とす)。先輩が
 * 「自分が何を板書したか」を知らないと、教え返しを聞いても
 * 「言えた / 詰まった」の判定ができない。板書がまだ無い場面(復習セッション・
 * 授業に入る前)は、その旨を**会話の言語で**書いた定型句を渡すこと。
 *
 * **板書の要約はここ(instructions)にだけ渡す。**カルテと小テストの材料は
 * transcript で、そこに教えた内容を混ぜると §2 の設計制約
 * 「出題元はユーザーが説明した内容。AIが教えた内容から作らない」が壊れる。
 * その線引きはプロンプト本文にも二重に書いてある。
 */
export function conversationSystemPrompt(
  variables: {
    photo_summary: string;
    visible_work: string;
    allowed_topics: string;
    question_seeds: string;
    lesson_recap: string;
    remaining_seconds: number;
  },
  { locale = defaultPromptLocale, subject }: PromptContext,
): string {
  return [
    renderPrompt(getPrompt("senpai_conversation", locale), variables),
    "---",
    getPrompt("question_types_few_shot", locale).body,
    "---",
    getPrompt(speechHintsId(subject), locale).body,
  ].join("\n\n");
}

/**
 * 板書つきで教える先輩のシステムプロンプト(ピボット計画 v1 §2 / §3-1)。
 *
 * 出力は `@ai-sensei/contract` の `boardLessonSchema` の形で、
 * agent がストリーミングJSONとして受け取る。
 *
 * **新規と復習で別のプロンプトを複製しない。**違うのは授業の根拠が
 * 「写真の問題」か「前回観測した1つの穴」かだけで、板書の契約、LaTeXの許可範囲、
 * 「数式は板書・声は接続」、教え返しへの受け渡しは同じ。300行を超える規約を
 * 別本にすると、片方だけ長い式の分割や禁止コマンドが抜けても型では検知できない。
 * `lesson_mode` を本文で明示し、入力の読み分けだけを同じ正本の中に置く。
 *
 * 復習の穴を `problem_text` に偽装する案も採らない。問題の写真が無いのに
 * 問題文として渡すと、「問題を推測しない」という新規授業の保険が形だけになる。
 * `review_context` は別の棚に置き、`problem_text` は写真についての事実のまま保つ。
 *
 * **音声補正ヒントを同梱する。** 先輩は喋るだけでなく、生徒の説明を聞いて
 * 「言えたか / 詰まったか」で教える地点を決める(=【申告させず、やらせる】)。
 * その判定材料はSTTを通った生徒の発話そのものなので、
 * 「さんぶんのに = 2/3」を取り違えると、**言えているのに詰まったと判定する**。
 *
 * few-shot(`question_types_few_shot`)は同梱しない。**先輩版に書き直したあとも同じ。**
 * あれは「教え返しを聞きながら差し込む一言」(相づち・足場・掘り方)の見本で、
 * こちらの出力は板書JSONなので置き場がない。`speech` の文体は
 * `senpai_board.<locale>.md` の見本セクションが直接そろえている。
 *
 * **残り時間はここに入れない。**授業は往復するので、残り時間を本文へ織り込むと
 * **パスごとにsystemが1文字変わる**。板書のsystemは4万字級で、それが変わるたびに
 * プロンプトキャッシュのプレフィックスが外れ、毎回書き込みだけ払って一度も読めない
 * (`lesson.ts` の `cache_control` の説明)。残り時間は印より後ろの別ブロックとして
 * 渡す(`senpai.ts` の `senpaiBoardRemainingNote`)。
 */
export function boardLessonSystemPrompt(
  variables: {
    lesson_mode: "new" | "review";
    problem_text: string;
    student_work: string;
    review_context: string;
    allowed_topics: string;
  },
  { locale = defaultPromptLocale, subject }: PromptContext,
): string {
  return [
    // **教科ごとに別本。** 数学版は300行超のうち3〜4割が数式の規約(使える
    // LaTeXコマンド・長い式の割り方)で、英語では丸ごと不要。1本に混ぜて
    // 分岐を書くより、正本を分けたほうが読める(ADR 0005 決定3と同じ判断)。
    renderPrompt(getPrompt(boardPromptId(subject), locale), variables),
    "---",
    getPrompt(speechHintsId(subject), locale).body,
  ].join("\n\n");
}

/**
 * 学習計画を口で聞いて組む先輩のシステムプロンプト(ピボット計画 v1 §4-3)。
 *
 * 出力は `@ai-sensei/contract` の `planTurnSchema`(`{speech, plan}`)の形。
 * 計画は聞き取りの会話の**途中で**生まれるので、LLMの単位は「計画」ではなく「1ターン」。
 *
 * **音声補正ヒントは同梱しない。** あれは数式の読み上げ(「さんぶんのに」= 2/3)や
 * 英語の音の脱落を直すためのもので、計画の聞き取りに出てくる数字は
 * **日付・ページ番号・問題集の名前**という別物。同梱しても効かないうえ、
 * 「エヌは数列ならn」のような文脈判断を持ち込むと、聞き取りの邪魔になる。
 * 計画側で要る聞き取りの注意は `prompts/study_plan.<locale>.md` に直接書いてある。
 *
 * **教科を取らないのもこのため。** 計画は教科をまたいで1本作る(中学生の定期テストは
 * 数学と英語が並ぶ)ので、ここで教科をひとつに決める意味がない。
 *
 * `today` は**必ず渡す**。LLMは今日を知らないので、「9月10日」が何日後かも、
 * 今年か来年かも決められない(渡し忘れは `renderPrompt` が落とす)。
 */
export function studyPlanSystemPrompt(
  variables: {
    today: string;
    allowed_topics: string;
    known_facts: string;
    current_plan: string;
    remaining_seconds: number;
  },
  locale: PromptLocale = defaultPromptLocale,
): string {
  return renderPrompt(getPrompt("study_plan", locale), variables);
}

/** カルテ生成用のプロンプト。教科に合った音声補正ヒントを同梱する。 */
export function karteSystemPrompt(
  variables: {
    problem_text: string;
    photo_summary: string;
    allowed_topics: string;
    transcript: string;
    is_premium: string;
  },
  { locale = defaultPromptLocale, subject }: PromptContext,
): string {
  return [
    renderPrompt(getPrompt("karte_generation", locale), variables),
    "---",
    getPrompt(speechHintsId(subject), locale).body,
  ].join("\n\n");
}
