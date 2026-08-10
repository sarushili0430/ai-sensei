/**
 * プロンプトの読み込みと穴埋め。
 *
 * Markdown(`prompts/<id>.<locale>.md`)が正で、TypeScript側は生成された文字列
 * 定数を使う。Workers/agentはファイルシステムを前提にできないため、この形にしている。
 */

/** プロンプトを持っている言語。カリキュラムのロケールと同じ集合。 */
export const promptLocales = ["ja", "en"] as const;
export type PromptLocale = (typeof promptLocales)[number];

/** 未知の値は日本語に丸める(既定の言語)。 */
export function toPromptLocale(value: string | undefined | null): PromptLocale {
  return promptLocales.find((locale) => locale === value) ?? "ja";
}

export type PromptMeta = {
  id: string;
  locale: string;
  model_role: string;
  variables: string[];
};

export type PromptTemplate = {
  meta: PromptMeta;
  /** フロントマターを除いた本文。 */
  body: string;
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** ごく限定的なフロントマターのパーサ(YAMLライブラリを持ち込まないため)。 */
export function parsePrompt(source: string): PromptTemplate {
  const match = FRONT_MATTER.exec(source);
  if (!match || match[1] === undefined) {
    throw new Error("プロンプトにフロントマターがありません");
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  const id = fields["id"];
  if (id === undefined || id.length === 0) throw new Error("フロントマターに id がありません");

  return {
    meta: {
      id,
      locale: fields["locale"] ?? "ja",
      model_role: fields["model_role"] ?? "shared",
      variables: parseList(fields["variables"] ?? "[]"),
    },
    body: source.slice(match[0].length).trim(),
  };
}

function parseList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export class PromptRenderError extends Error {}

/**
 * `{{variable}}` を埋める。
 *
 * 宣言されていない変数を渡した場合も、埋め残しがある場合もエラーにする。
 * プロンプトの穴埋め漏れは、そのまま「許可リストが空の状態でLLMを走らせる」に
 * つながり、範囲逸脱の直接の原因になるため、静かに通さない。
 */
export function renderPrompt(
  template: PromptTemplate,
  variables: Record<string, string | number> = {},
): string {
  const provided = Object.keys(variables);
  const declared = new Set(template.meta.variables);

  const undeclared = provided.filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new PromptRenderError(
      `${template.meta.id}: 宣言されていない変数が渡されました: ${undeclared.join(", ")}`,
    );
  }

  const missing = template.meta.variables.filter((name) => !(name in variables));
  if (missing.length > 0) {
    throw new PromptRenderError(
      `${template.meta.id}: 変数が渡されていません: ${missing.join(", ")}`,
    );
  }

  // 宣言外のプレースホルダは空文字で潰さず、そのまま残して下の検査で落とす。
  const rendered = template.body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) =>
    name in variables ? String(variables[name]) : match,
  );

  const leftover = /\{\{\s*[\w.]+\s*\}\}/.exec(rendered);
  if (leftover) {
    throw new PromptRenderError(`${template.meta.id}: 未展開のプレースホルダ: ${leftover[0]}`);
  }

  return rendered;
}

/**
 * プロンプトに差し込む定型句。
 * **本文と同じ言語で入れる。** 日本語の「(なし)」が英語のプロンプトに混ざると、
 * モデルはそこだけ日本語で応答しはじめる。
 */
const phrases: Record<
  PromptLocale,
  {
    noTopics: string;
    none: string;
    noSpeech: string;
    noNotesPhoto: string;
    noProblemPhoto: string;
  }
> = {
  ja: {
    noTopics: "(なし — 質問を作らず、写真の撮り直しを促してください)",
    none: "(なし)",
    noSpeech: "(発話なし)",
    noNotesPhoto: "(ノートの写真なし)",
    noProblemPhoto: "(問題の写真なし)",
  },
  en: {
    noTopics: "(none — do not build a question; ask for another photo of the notes)",
    none: "(none)",
    noSpeech: "(nothing was said)",
    noNotesPhoto: "(no photo of their notes)",
    noProblemPhoto: "(no photo of the problem)",
  },
};

/**
 * 会話のロール名。transcriptを読むLLMに、誰の発話かを言語ごとに伝える。
 *
 * ピボット(計画 v1 §0 決定3)でAI側の配役が**後輩から先輩に変わった**ので、
 * ここも「後輩 / Kohai」から替えている。ラベルだけ後輩のまま残すと、
 * カルテを書くLLMは**先輩が教えた行を「後輩の発話」として読む** — 誰が誰に
 * 教えていたのかが逆に見える transcript から穴を抽出することになる。
 * `prompts/karte_generation.<locale>.md` の本文と対で直すこと。
 */
const roleLabels: Record<PromptLocale, { assistant: string; user: string }> = {
  ja: { assistant: "先輩", user: "ユーザー" },
  en: { assistant: "Senpai", user: "Student" },
};

/** 許可トピックの一覧を、プロンプトに貼れる形に整える。 */
export function formatAllowedTopics(
  topics: readonly { id: string; course: string; unit: string; topic: string; goals: string[] }[],
  locale: PromptLocale = "ja",
): string {
  if (topics.length === 0) return phrases[locale].noTopics;
  return topics
    .map((topic) =>
      [
        `- ${topic.id} — ${topic.course} / ${topic.unit} / ${topic.topic}`,
        ...topic.goals.map((goal) => `    - ${goal}`),
      ].join("\n"),
    )
    .join("\n");
}

/** 箇条書きにする(写真の作業内容・質問の種など)。 */
export function formatBullets(items: readonly string[], locale: PromptLocale = "ja"): string {
  if (items.length === 0) return phrases[locale].none;
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * 問題文を、プロンプトに貼れる形に整える。
 *
 * `null` = **読み取れなかった**。`prompts/senpai_board.<locale>.md` はこの文字列を
 * 名指しで見ていて(「ここが『(問題の写真なし)』のときは、問題文を推測で
 * 組み立てないこと」)、1文字ずれるとその指示が発火しないまま
 * **先輩が自分で作った問題を教えはじめる**。だから文言はここにしか置かない。
 *
 * **空文字を `null` に畳まない。**「読めなかった」を `null` に寄せるのは
 * 呼び出し側(`backend/api` の `resolveSessionProblem()`)の責務で、
 * 上限超過も空も向こうで畳んでから渡ってくる。ここで `""` を拾って
 * プレースホルダに化けさせると、**契約違反が無音で通る** —
 * 空のまま素通しすれば、agent 側の `.min(1)` で会話が始まらずに表面化する。
 */
export function formatProblemText(text: string | null, locale: PromptLocale = "ja"): string {
  return text === null ? phrases[locale].noProblemPhoto : text;
}

/**
 * ノートから読み取れた作業を、プロンプトに貼れる形に整える。
 *
 * **区別する状態は3つ。**`formatBullets` を直に使うと下2つが同じ「(なし)」になり、
 * 先輩は**「ノートに何も書いていない生徒」と「ノートを撮らなかった生徒」を同じに扱う**
 * (`contract` の `sessionMetadataSchema.visible_work` が3状態を要求している理由)。
 *
 * | 引数 | 出る値 | 意味 |
 * | --- | --- | --- |
 * | 中身のある配列 | 箇条書き | ノートの写真から読み取れた |
 * | `[]` | `(なし)` | ノートは撮ったが、手をつけた形跡が読み取れなかった |
 * | `null` | `(ノートの写真なし)` | **ノートの写真そのものが無い**(問題だけを持ってきた) |
 *
 * **文言はここにしか無い。**`prompts/senpai_board.<locale>.md` と
 * `prompts/senpai_conversation.<locale>.md` がこの文字列を名指しで見ているので、
 * backend/api も agent も自前で組み立てず、この関数を通すこと。
 * 1文字ずれるとプロンプト側の分岐が発火せず、**先輩が「ノート見せて」と言い出す** —
 * その生徒はノートを持っていない。
 */
export function formatVisibleWork(
  items: readonly string[] | null,
  locale: PromptLocale = "ja",
): string {
  if (items === null) return phrases[locale].noNotesPhoto;
  return formatBullets(items, locale);
}

/** transcriptをカルテ生成プロンプトに貼れる形にする。 */
export function formatTranscript(
  messages: readonly { role: string; text: string }[],
  locale: PromptLocale = "ja",
): string {
  if (messages.length === 0) return phrases[locale].noSpeech;
  const labels = roleLabels[locale];
  return messages
    .map(
      (message) =>
        `${message.role === "assistant" ? labels.assistant : labels.user}: ${message.text}`,
    )
    .join("\n");
}
