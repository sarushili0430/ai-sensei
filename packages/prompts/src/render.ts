/**
 * プロンプトの読み込みと穴埋め。
 *
 * Markdown(`prompts/*.ja.md`)が正で、TypeScript側は生成された文字列定数を使う。
 * Workers/agentはファイルシステムを前提にできないため、この形にしている。
 */

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

/** 許可トピックの一覧を、プロンプトに貼れる形に整える。 */
export function formatAllowedTopics(
  topics: readonly { id: string; course: string; unit: string; topic: string; goals: string[] }[],
): string {
  if (topics.length === 0) return "(なし — 質問を作らず、写真の撮り直しを促してください)";
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
export function formatBullets(items: readonly string[], emptyText = "(なし)"): string {
  if (items.length === 0) return emptyText;
  return items.map((item) => `- ${item}`).join("\n");
}

/** transcriptをカルテ生成プロンプトに貼れる形にする。 */
export function formatTranscript(
  messages: readonly { role: string; text: string }[],
): string {
  if (messages.length === 0) return "(発話なし)";
  return messages
    .map((message) => `${message.role === "assistant" ? "後輩" : "ユーザー"}: ${message.text}`)
    .join("\n");
}
