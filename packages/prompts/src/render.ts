/**
 * Loading prompts and filling their blanks.
 *
 * The Markdown (`prompts/<id>.<locale>.md`) is authoritative, and the TypeScript
 * side uses generated string constants. Workers and the agent cannot assume a
 * filesystem, hence this shape.
 */

/** The languages that have prompts. The same set as the curriculum locales. */
export const promptLocales = ["ja", "en"] as const;
export type PromptLocale = (typeof promptLocales)[number];

/** Unknown values are rounded to Japanese (the default language). */
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
  /** The body without the front matter. */
  body: string;
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** A very limited front-matter parser (so no YAML library is pulled in). */
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
 * Fills in `{{variable}}`.
 *
 * Passing an undeclared variable is an error, and so is leaving a blank unfilled.
 * An unfilled prompt blank leads straight to "run the LLM with an empty allow-list",
 * a direct cause of going out of scope, so it never passes silently.
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

  // Undeclared placeholders are not squashed to an empty string; they are left in place and caught by the check below.
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
 * Fixed phrases inserted into prompts.
 * Written in the same language as the body. A Japanese "(none)" mixed into an
 * English prompt makes the model start answering in Japanese there.
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
 * Conversation role labels. They tell the LLM reading the transcript who spoke, per
 * language.
 *
 * The pivot (plan v1 §0 decision 3) changed the AI's role from kouhai to senpai, so
 * these changed from "後輩 / Kohai" too. Leaving the labels as kouhai would make the
 * karte LLM read the lines the senpai taught as "the kouhai's speech" - extracting
 * holes from a transcript where who was teaching whom looks reversed.
 * Fix this together with the body of `prompts/karte_generation.<locale>.md`.
 */
const roleLabels: Record<PromptLocale, { assistant: string; user: string }> = {
  ja: { assistant: "先輩", user: "ユーザー" },
  en: { assistant: "Senpai", user: "Student" },
};

/**
 * A topic *index*. Drops the learning goals to make one line each.
 *
 * In a plan interview the LLM only picks the test scope's topic_ids, and goals do
 * not inform that choice (goals are needed on the lesson side, which builds
 * questions). It pays off where a whole curriculum is pasted: measured at
 * 125 -> 48 characters per topic, and 6,516 -> 2,503 characters for Japanese
 * high-school maths (52 entries).
 *
 * No information is lost, so use it alongside {@link formatAllowedTopics}: lessons
 * (scope narrowed to a few) get goals, plans (a whole curriculum pasted) get the index.
 */
export function formatTopicIndex(
  topics: readonly { id: string; course: string; unit: string; topic: string }[],
  locale: PromptLocale = "ja",
): string {
  if (topics.length === 0) return phrases[locale].noTopics;
  return topics
    .map((topic) => `- ${topic.id} — ${topic.course} / ${topic.unit} / ${topic.topic}`)
    .join("\n");
}

/** Formats the allowed-topic list so it can be pasted into a prompt. */
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

/** Formats bullets (work seen in the photo, question seeds, ...). */
export function formatBullets(items: readonly string[], locale: PromptLocale = "ja"): string {
  if (items.length === 0) return phrases[locale].none;
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Formats the problem text so it can be pasted into a prompt.
 *
 * `null` means it was unreadable. `prompts/senpai_board.<locale>.md` matches this
 * string by name ("when this says '(no problem photo)', do not reconstruct the
 * problem text by guessing"), and one character of drift stops that instruction
 * firing - and the senpai starts teaching a problem it invented. So the wording
 * lives only here.
 *
 * An empty string is not folded into `null`. Folding "unreadable" into `null` is the
 * caller's job (`resolveSessionProblem()` in `backend/api`), and both the
 * over-length and the empty cases are folded there before arriving. Catching `""`
 * here and turning it into the placeholder would let a contract violation pass
 * silently - passed through empty, the agent's `.min(1)` surfaces it by refusing to
 * start the conversation.
 */
export function formatProblemText(text: string | null, locale: PromptLocale = "ja"): string {
  return text === null ? phrases[locale].noProblemPhoto : text;
}

/**
 * Formats the work read from the notes so it can be pasted into a prompt.
 *
 * Three states must stay distinct. Using `formatBullets` directly collapses the
 * bottom two into the same "(none)", and the senpai then treats "a student who wrote
 * nothing" the same as "a student who took no notes photo" (the reason
 * `contract`'s `sessionMetadataSchema.visible_work` demands three states).
 *
 * | argument | output | meaning |
 * | --- | --- | --- |
 * | a non-empty array | bullets | read from the notes photo |
 * | `[]` | `(なし)` | notes were photographed, but no sign of work could be read |
 * | `null` | `(ノートの写真なし)` | there is no notes photo at all (only the problem was brought) |
 *
 * The wording exists only here. `prompts/senpai_board.<locale>.md` and
 * `prompts/senpai_conversation.<locale>.md` match these strings by name, so neither
 * backend/api nor the agent may assemble them itself - both go through this
 * function. One character of drift stops the prompt's branch firing, and the senpai
 * asks to see the notes - from a student who has none.
 */
export function formatVisibleWork(
  items: readonly string[] | null,
  locale: PromptLocale = "ja",
): string {
  if (items === null) return phrases[locale].noNotesPhoto;
  return formatBullets(items, locale);
}

/** Formats the transcript so it can be pasted into the karte-generation prompt. */
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
