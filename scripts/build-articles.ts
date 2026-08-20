/**
 * 記事(Markdown)を、配信するHTMLに焼く。
 *
 * **正は `apps/lp/articles/<slug>.md`、配信されるのは生成した
 * `apps/lp/public/articles/<slug>/index.html`。** apps/lp はビルド工程を持たない静的配信で
 * (`apps/lp/README.md`)、wrangler は `public/` をそのまま上げるだけなので、HTMLは
 * コミットしておく必要がある。「絵の正はコード」(README)と同じ扱いなので、
 * **生成物を手で直さないこと** —— 次の生成で必ず消える。
 *
 * Markdownは意図的に狭い部分集合しか読まない。読めない記法は黙って素通しせず、
 * 行番号を添えて落とす —— LPは公開前のレビューが人の目しかないので、
 * 「書いたつもりの装飾が本文にそのまま出ている」たぐいの事故に気づけるのは、
 * ここで止めたときだけになる。書ける記法は `apps/lp/articles/README.md`。
 *
 *   pnpm run articles:build    生成する(記事を足す・直したら必ず走らせる)
 *   pnpm run verify:articles   生成物が最新かだけを見る(pnpm run verify と CI)
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 記事の正(Markdown)。`public/` の外に置くので、素の `.md` は配信されない。 */
export const SOURCE_DIR = "apps/lp/articles";
/** 生成物。**この下の `index.html` はすべてこのスクリプトが持ち主**。 */
export const OUTPUT_DIR = "apps/lp/public/articles";

/** front matter に書ける項目。ここに無い項目は綴り間違いとして落とす。 */
const KNOWN_KEYS = ["title", "description", "date", "updated", "draft"] as const;

/** `<title>` に収まる長さ。超えると検索結果でもLPのヘッダでも切れる。 */
const TITLE_MAX = 60;
/** `<meta name="description">`。Googleが切る長さに合わせる。 */
const DESCRIPTION_MAX = 160;

/** 目次を出す見出しの数。2本以下なら、目次のほうが本文より目立ってしまう。 */
const TOC_MIN_HEADINGS = 3;

export type ArticleMeta = {
  /** ファイル名から取る。そのままURLになる(`/articles/<slug>/`)。 */
  slug: string;
  title: string;
  description: string;
  /** 公開日 `YYYY-MM-DD`。並び順の正。 */
  date: string;
  /** 改稿日。直したときだけ入れる。 */
  updated: string | null;
  /** `true` のあいだは生成しない(手元で読める形にはならない)。 */
  draft: boolean;
};

export type Article = ArticleMeta & {
  /** front matter を除いた本文(Markdown)。 */
  markdown: string;
  /** 本文が元ファイルの何行目から始まるか。落ちた行を元ファイルの行番号で出すために持つ。 */
  bodyOffset: number;
};

/** 直せる場所が分かる失敗。`file` と `line` は人が開く場所そのもの。 */
export class ArticleError extends Error {
  readonly file: string;
  readonly line: number | null;

  constructor(file: string, line: number | null, message: string) {
    super(message);
    this.name = "ArticleError";
    this.file = file;
    this.line = line;
  }

  /** `apps/lp/articles/foo.md:12  理由` の形。 */
  format(): string {
    const at = this.line === null ? this.file : `${this.file}:${this.line}`;
    return `${at}  ${this.message}`;
  }
}

// -------------------------------------------------------------------------- //
// front matter
// -------------------------------------------------------------------------- //

/**
 * `---` で挟んだ `key: value` を読む。YAMLは通していない(入れ子も配列も要らないので、
 * ライブラリを足すより、書ける形を狭くして読めない書き方を落とすほうが早く気づける)。
 */
export function parseFrontMatter(file: string, slug: string, source: string): Article {
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  if ((lines[0] ?? "") !== "---") {
    throw new ArticleError(file, 1, "1行目が `---` で始まっていません(front matter が要ります)");
  }

  const values = new Map<string, string>();
  let cursor = 1;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? "";
    if (line === "---") break;
    if (line.trim() === "") continue;

    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new ArticleError(file, cursor + 1, `\`key: value\` の形ではありません: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw new ArticleError(
        file,
        cursor + 1,
        `知らない項目 \`${key}\` です(書けるのは ${KNOWN_KEYS.join(" / ")})`,
      );
    }
    if (values.has(key)) {
      throw new ArticleError(file, cursor + 1, `\`${key}\` が2回書かれています`);
    }
    values.set(key, stripQuotes(value));
  }

  if (cursor >= lines.length) {
    throw new ArticleError(file, lines.length, "front matter を閉じる `---` がありません");
  }

  const meta = validateMeta(file, slug, values);
  return { ...meta, markdown: lines.slice(cursor + 1).join("\n"), bodyOffset: cursor + 1 };
}

function stripQuotes(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return quoted?.[1] ?? value;
}

function validateMeta(file: string, slug: string, values: Map<string, string>): ArticleMeta {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ArticleError(
      file,
      null,
      "ファイル名は英小文字・数字・ハイフンだけにしてください(そのままURLになります)",
    );
  }

  const title = required(file, values, "title");
  if ([...title].length > TITLE_MAX) {
    throw new ArticleError(file, null, `title が長すぎます(${TITLE_MAX}文字まで)`);
  }

  const description = required(file, values, "description");
  if ([...description].length > DESCRIPTION_MAX) {
    throw new ArticleError(
      file,
      null,
      `description が長すぎます(${DESCRIPTION_MAX}文字まで。検索結果で切れます)`,
    );
  }

  const date = requireDate(file, values, "date");
  const rawUpdated = values.get("updated");
  const updated =
    rawUpdated === undefined || rawUpdated === "" ? null : requireDate(file, values, "updated");
  if (updated !== null && updated < date) {
    throw new ArticleError(file, null, "updated が date より前になっています");
  }

  const rawDraft = values.get("draft") ?? "false";
  if (rawDraft !== "true" && rawDraft !== "false") {
    throw new ArticleError(file, null, "draft は true か false で書いてください");
  }

  return { slug, title, description, date, updated, draft: rawDraft === "true" };
}

function required(file: string, values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value === "") {
    throw new ArticleError(file, null, `\`${key}\` が空です`);
  }
  return value;
}

/** `YYYY-MM-DD` かつ実在する日付か。`2026-02-31` はここで落ちる。 */
function requireDate(file: string, values: Map<string, string>, key: string): string {
  const value = required(file, values, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ArticleError(file, null, `\`${key}\` は YYYY-MM-DD で書いてください: ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ArticleError(file, null, `\`${key}\` が実在しない日付です: ${value}`);
  }
  return value;
}

// -------------------------------------------------------------------------- //
// Markdown(狭い部分集合)
// -------------------------------------------------------------------------- //

export type Heading = { id: string; text: string };

/** 書けない記法。読み飛ばさずに、その行で止める。 */
const UNSUPPORTED: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^#(?!#)\s/,
    reason: "`# ` は使いません(記事の題は front matter の title が持ちます)",
  },
  { pattern: /^#{4,}\s/, reason: "見出しは `## ` と `### ` の2段までです" },
  { pattern: /^(```|~~~)/, reason: "コードブロックは書けません" },
  { pattern: /^\|/, reason: "表は書けません(必要になったら生成側に足すこと)" },
  { pattern: /^!\[/, reason: "画像は置けません(OGP画像もまだ無いので、先にそちらを決めること)" },
  { pattern: /^\s+\S/, reason: "行頭に空白を置かないでください(入れ子のリストは書けません)" },
  { pattern: /^(---|\*\*\*|___)\s*$/, reason: "区切り線は書けません" },
  { pattern: /<\/?[a-zA-Z][^>]*>/, reason: "生のHTMLは書けません(`<` は文字としてなら書けます)" },
];

/**
 * 本文をHTMLにする。**段落の中の改行は、こちらで潰してから出す**(`joinLines`)。
 */
export function renderMarkdown(
  file: string,
  markdown: string,
  lineOffset: number,
): {
  html: string;
  headings: Heading[];
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const headings: Heading[] = [];
  let h2Count = 0;
  let h3Count = 0;
  let index = 0;

  const lineNumber = (at: number): number => at + lineOffset + 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index++;
      continue;
    }

    for (const { pattern, reason } of UNSUPPORTED) {
      if (pattern.test(line)) throw new ArticleError(file, lineNumber(index), reason);
    }

    if (line.startsWith("## ")) {
      h2Count++;
      h3Count = 0;
      const id = `s${h2Count}`;
      const text = line.slice(3).trim();
      headings.push({ id, text });
      out.push(`<h2 id="${id}">${renderInline(file, lineNumber(index), text)}</h2>`);
      index++;
      continue;
    }

    if (line.startsWith("### ")) {
      if (h2Count === 0) {
        throw new ArticleError(file, lineNumber(index), "`### ` の前に `## ` が要ります");
      }
      h3Count++;
      const id = `s${h2Count}-${h3Count}`;
      const text = line.slice(4).trim();
      out.push(`<h3 id="${id}">${renderInline(file, lineNumber(index), text)}</h3>`);
      index++;
      continue;
    }

    if (line.startsWith("- ") || /^\d+\. /.test(line)) {
      const ordered = !line.startsWith("- ");
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index] ?? "";
        const bullet = ordered ? /^\d+\. /.exec(item) : /^- /.exec(item);
        if (bullet === null) break;
        const text = item.slice(bullet[0].length).trim();
        items.push(`  <li>${renderInline(file, lineNumber(index), text)}</li>`);
        index++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>\n${items.join("\n")}\n</${tag}>`);
      continue;
    }

    if (line.startsWith("> ")) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) {
        quoted.push(renderInline(file, lineNumber(index), (lines[index] ?? "").slice(2).trim()));
        index++;
      }
      out.push(`<blockquote>\n  <p>${joinLines(quoted)}</p>\n</blockquote>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const text = lines[index] ?? "";
      if (text.trim() === "" || startsBlock(text)) break;
      for (const { pattern, reason } of UNSUPPORTED) {
        if (pattern.test(text)) throw new ArticleError(file, lineNumber(index), reason);
      }
      paragraph.push(renderInline(file, lineNumber(index), text.trim()));
      index++;
    }
    out.push(`<p>${joinLines(paragraph)}</p>`);
  }

  return { html: out.join("\n\n"), headings };
}

/**
 * 段落の中の改行を潰す。**日本語どうしなら詰めて、そうでなければ空白1つで繋ぐ。**
 *
 * HTMLに改行をそのまま置くと、ブラウザはそれを空白1つに潰す。CSS Text 3 には
 * 日本語どうしの改行を消す規定があるが、**Chromiumは入れたままにする**
 * (実測: `日本語です。` + 改行 + `ここで改行` が、繋げて書いたときより7.5px広い)。
 * 読む人には「。 カ」のような**中黒のない中途半端な空き**として出るので、
 * ブラウザに任せず、ここで決めてしまう。
 *
 * 見るのは繋ぎ目の1文字だけ。タグを外してから見るので、
 * 行が `**強調**` で始まっていても、その中の日本語で判断できる。
 */
export function joinLines(lines: readonly string[]): string {
  return lines
    .map((line, index) => {
      if (index === 0) return line;
      const previous = edgeChar(lines[index - 1] ?? "", "end");
      const next = edgeChar(line, "start");
      return (JAPANESE.test(previous) && JAPANESE.test(next) ? "" : " ") + line;
    })
    .join("");
}

/** 仮名・漢字・全角の記号。ここに入る文字どうしなら、空白を入れない。 */
const JAPANESE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function edgeChar(html: string, side: "end" | "start"): string {
  const text = html.replace(/<[^>]*>/g, "");
  return (side === "end" ? text.at(-1) : text[0]) ?? "";
}

function startsBlock(line: string): boolean {
  return (
    line.startsWith("## ") ||
    line.startsWith("### ") ||
    line.startsWith("- ") ||
    line.startsWith("> ") ||
    /^\d+\. /.test(line)
  );
}

/** `` `code` `` / `**強調**` / `==マーカー==` / `[文字](URL)`。それ以外は文字として出す。 */
const INLINE = /`([^`]+)`|\*\*([^*]+?)\*\*|==([^=]+?)==|\[([^\]]+?)\]\(([^)\s]+?)\)/g;

/** 飛べる先。`javascript:` などを書けなくしておく(記事は人が書くが、機械も書く)。 */
const SAFE_HREF = /^(?:https:\/\/|mailto:|#|\.{1,2}\/|\/)/;

export function renderInline(file: string, line: number, text: string): string {
  let out = "";
  let last = 0;

  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    out += escapeHtml(text.slice(last, match.index));
    const [, code, strong, marked, label, href] = match;

    if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else if (strong !== undefined) out += `<strong>${escapeHtml(strong)}</strong>`;
    else if (marked !== undefined) out += `<span class="mk">${escapeHtml(marked)}</span>`;
    else if (label !== undefined && href !== undefined) {
      if (!SAFE_HREF.test(href)) {
        throw new ArticleError(
          file,
          line,
          `リンク先が https / mailto / 相対パス ではありません: ${href}`,
        );
      }
      out += `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    }

    last = match.index + match[0].length;
  }

  return out + escapeHtml(text.slice(last));
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `2026-08-20` → `2026年8月20日`。Intlに任せると環境でぶれるので、文字列から組む。 */
export function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

// -------------------------------------------------------------------------- //
// ページ
// -------------------------------------------------------------------------- //

/** どのページも同じ頭を持つ。**手で書いた `public/` 配下のページと揃えること。** */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230EA5E9'/%3E%3Cpath d='M40.3 77.5L25.5 83.5L20.7 59.1Z' fill='%23FBFAF7'/%3E%3Ccircle cx='50' cy='47.5' r='31.5' fill='%23FBFAF7'/%3E%3Cg fill='none' stroke='%2333323D' stroke-width='5.2' stroke-linecap='round'%3E%3Cpath d='M30 46Q37.5 37 45 46'/%3E%3Cpath d='M55 46Q62.5 37 70 46'/%3E%3Cpath d='M58.4 57.3A8.5 5 0 0 1 41.6 57.2'/%3E%3C/g%3E%3C/svg%3E";

/** ヘッダ。`public/terms/index.html` の写し(あちらが正)。 */
function header(toRoot: string): string {
  return `<header class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="${toRoot}">
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <rect width="100" height="100" rx="22" fill="#0EA5E9"/>
        <path d="M40.3 77.5 L25.5 83.5 L20.7 59.1 Z" fill="#FBFAF7"/>
        <circle cx="50" cy="47.5" r="31.5" fill="#FBFAF7"/>
        <circle cx="29.5" cy="53.5" r="4.2" fill="#FFC0D4"/>
        <circle cx="70.5" cy="53.5" r="4.2" fill="#FFC0D4"/>
        <g fill="none" stroke="#33323D" stroke-width="5.2" stroke-linecap="round">
          <path d="M30 46 Q37.5 37 45 46"/>
          <path d="M55 46 Q62.5 37 70 46"/>
          <path d="M58.4 57.3 A8.5 5 0 0 1 41.6 57.2"/>
        </g>
      </svg>
      カタルテ
    </a>
  </div>
</header>`;
}

type PageOptions = {
  title: string;
  description: string;
  /** ページから `public/` へ戻る相対パス(`../` / `../../`)。 */
  toRoot: string;
  /** `<head>` に足す行。OGPなどページごとに違うもの。 */
  head?: string[];
  /** 検索に載せない(まだ中身が無い一覧など)。 */
  noindex?: boolean;
  main: string;
};

function page(options: PageOptions): string {
  const meta = [
    `<title>${escapeHtml(options.title)}</title>`,
    `<meta name="description" content="${escapeHtml(options.description)}">`,
    ...(options.noindex === true ? ['<meta name="robots" content="noindex">'] : []),
    ...(options.head ?? []),
    '<meta name="theme-color" content="#FBFAF7">',
  ];

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${meta.join("\n")}

<link rel="icon" href="${FAVICON}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${options.toRoot}styles.css">
</head>
<body>

<a class="skip" href="#main">本文へ</a>

${header(options.toRoot)}

${options.main}

</body>
</html>
`;
}

/** 1本ぶんのページ。`public/articles/<slug>/index.html`。 */
export function renderArticlePage(article: Article): string {
  const { html, headings } = renderMarkdown(
    sourcePath(article.slug),
    article.markdown,
    article.bodyOffset,
  );

  const published = `<time datetime="${article.date}">${formatDate(article.date)}</time> 公開`;
  const updated =
    article.updated === null
      ? ""
      : ` ／ <time datetime="${article.updated}">${formatDate(article.updated)}</time> 更新`;

  const toc =
    headings.length < TOC_MIN_HEADINGS
      ? ""
      : `  <nav class="article-toc" aria-label="目次">
    <p class="article-toc-h">目次</p>
    <ol>
${headings
  .map((heading) => `      <li><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
  .join("\n")}
    </ol>
  </nav>

`;

  return page({
    title: `${article.title} — カタルテ`,
    description: article.description,
    toRoot: "../../",
    head: [
      '<meta property="og:type" content="article">',
      '<meta property="og:locale" content="ja_JP">',
      `<meta property="og:title" content="${escapeHtml(article.title)}">`,
      `<meta property="og:description" content="${escapeHtml(article.description)}">`,
      `<meta property="article:published_time" content="${article.date}">`,
      '<meta name="twitter:card" content="summary_large_image">',
    ],
    main: `<main class="article" id="main">

  <h1>${escapeHtml(article.title)}</h1>
  <p class="updated">${published}${updated}</p>

${toc}${indent(html)}

  <a class="article-back" href="../">← 記事の一覧へ</a>

</main>`,
  });
}

/** 一覧。`public/articles/index.html`。 */
export function renderIndexPage(articles: readonly Article[]): string {
  const empty = articles.length === 0;
  const list = empty
    ? '  <p class="tiny">まだ記事はありません。</p>'
    : `  <ul class="article-list">
${articles
  .map(
    (article) => `    <li>
      <a href="./${article.slug}/">
        <time class="article-date" datetime="${article.date}">${formatDate(article.date)}</time>
        <span class="article-name">${escapeHtml(article.title)}</span>
        <span class="article-lead">${escapeHtml(article.description)}</span>
      </a>
    </li>`,
  )
  .join("\n")}
  </ul>`;

  return page({
    title: "記事 — カタルテ",
    description:
      "カタルテ(ai-sensei)の記事。教わったその場で教え返す勉強のしかたと、アプリの作り方について書いています。",
    toRoot: "../",
    // 1本も無いあいだは検索に載せない。空の一覧が拾われると、記事を出したあとも
    // 「中身の無いページ」としての評価が先に付いたままになる。
    noindex: empty,
    main: `<main class="article-index" id="main">

  <h1>記事</h1>
  <p class="lede">教わったその場で教え返す勉強のしかたと、カタルテの作り方について。</p>

${list}

  <a class="article-back" href="../">← カタルテのトップへ</a>

</main>`,
  });
}

function indent(html: string): string {
  return html
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

function sourcePath(slug: string): string {
  return `${SOURCE_DIR}/${slug}.md`;
}

// -------------------------------------------------------------------------- //
// 読み込みと書き出し
// -------------------------------------------------------------------------- //

/**
 * `apps/lp/articles/*.md` を全部読む。落ちた記事はそこで止めず、
 * **理由をためて最後にまとめて出す** —— 1本直すたびに走らせ直す形にしない。
 */
export function collectArticles(repoRoot: string): {
  articles: Article[];
  problems: ArticleError[];
} {
  const dir = resolve(repoRoot, SOURCE_DIR);
  const articles: Article[] = [];
  const problems: ArticleError[] = [];

  const names = readdirSync(dir, { encoding: "utf8" })
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();

  for (const name of names) {
    const slug = name.slice(0, -".md".length);
    const file = `${SOURCE_DIR}/${name}`;
    try {
      const article = parseFrontMatter(file, slug, readFileSync(join(dir, name), "utf8"));
      // 本文が読めるかは、ここで一度通して確かめる(下書きも含めて見る。
      // 公開の直前に初めて落ちると、直す時間がいちばん無い)。
      renderMarkdown(file, article.markdown, article.bodyOffset);
      articles.push(article);
    } catch (error) {
      problems.push(
        error instanceof ArticleError ? error : new ArticleError(file, null, String(error)),
      );
    }
  }

  return { articles, problems };
}

/** 新しい順。同じ日ならファイル名順(並びが日によって入れ替わらないようにする)。 */
export function publishedArticles(articles: readonly Article[]): Article[] {
  return articles
    .filter((article) => !article.draft)
    .sort((a, b) =>
      a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date),
    );
}

/** 配信する形。キーはリポジトリルートからの相対パス。 */
export function buildPages(articles: readonly Article[]): Map<string, string> {
  const published = publishedArticles(articles);
  const pages = new Map<string, string>();
  pages.set(`${OUTPUT_DIR}/index.html`, renderIndexPage(published));
  for (const article of published) {
    pages.set(`${OUTPUT_DIR}/${article.slug}/index.html`, renderArticlePage(article));
  }
  return pages;
}

/**
 * いま `public/articles/` にある生成物。
 *
 * **見るのは `index.html` だけ。** ここに画像などを置く日が来ても、
 * 生成の巻き添えで消えないようにしておく(消してよいのは、自分で書いたものだけ)。
 */
export function listGeneratedFiles(repoRoot: string): string[] {
  const root = resolve(repoRoot, OUTPUT_DIR);
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { encoding: "utf8" });
    } catch {
      return; // まだ1度も生成していない
    }
    for (const entry of entries.sort()) {
      const path = join(dir, entry);
      if (readdirSafe(path) !== null) walk(path);
      else if (entry === "index.html") found.push(relative(resolve(repoRoot), path));
    }
  };

  walk(root);
  return found;
}

function readdirSafe(path: string): string[] | null {
  try {
    return readdirSync(path, { encoding: "utf8" });
  } catch {
    return null;
  }
}

export type Difference =
  | { kind: "stale"; file: string }
  | { kind: "missing"; file: string }
  | { kind: "orphan"; file: string };

/** 生成物と、いまの記事を突き合わせる。`--check` はこれだけを見る。 */
export function diffPages(repoRoot: string, pages: ReadonlyMap<string, string>): Difference[] {
  const differences: Difference[] = [];

  for (const [file, html] of pages) {
    let current: string;
    try {
      current = readFileSync(resolve(repoRoot, file), "utf8");
    } catch {
      differences.push({ kind: "missing", file });
      continue;
    }
    if (current !== html) differences.push({ kind: "stale", file });
  }

  for (const file of listGeneratedFiles(repoRoot)) {
    if (!pages.has(file)) differences.push({ kind: "orphan", file });
  }

  return differences;
}

/** 差があるものだけ書く(mtimeを無駄に動かさない)。消えた記事の生成物は片付ける。 */
export function writePages(repoRoot: string, pages: ReadonlyMap<string, string>): Difference[] {
  const written = diffPages(repoRoot, pages);

  for (const [file, html] of pages) {
    const path = resolve(repoRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html, "utf8");
  }

  for (const difference of written) {
    if (difference.kind !== "orphan") continue;
    const path = resolve(repoRoot, difference.file);
    rmSync(path);
    const dir = dirname(path);
    // 記事ごとのディレクトリは、中身が無くなったら畳む。
    // `public/articles/` 自体は一覧が残るので、ここには来ない。
    if ((readdirSafe(dir) ?? ["keep"]).length === 0) rmSync(dir, { recursive: true });
  }

  return written;
}

// -------------------------------------------------------------------------- //
// CLI
// -------------------------------------------------------------------------- //

/** `--check` は「合っていない理由」を、生成は「何をしたか」を出す。 */
const CHECK_LABELS: Record<Difference["kind"], string> = {
  stale: "古い  ",
  missing: "無い  ",
  orphan: "余分  ",
};

const BUILD_LABELS: Record<Difference["kind"], string> = {
  stale: "更新  ",
  missing: "新規  ",
  orphan: "削除  ",
};

function main(): void {
  const repoRoot = resolve(import.meta.dirname, "..");
  const check = process.argv.includes("--check");

  const { articles, problems } = collectArticles(repoRoot);
  if (problems.length > 0) {
    console.error("✘ 記事を読めませんでした:");
    for (const problem of problems) console.error(`  ${problem.format()}`);
    console.error(`\n書ける形は ${SOURCE_DIR}/README.md にあります。`);
    process.exitCode = 1;
    return;
  }

  const pages = buildPages(articles);
  const drafts = articles.length - pages.size + 1;

  if (check) {
    const differences = diffPages(repoRoot, pages);
    if (differences.length === 0) {
      console.log(
        `✔ 記事の生成物は最新です (${pages.size - 1}本${drafts > 0 ? ` + 下書き${drafts}本` : ""})`,
      );
      return;
    }
    console.error("✘ 生成物が記事と合っていません:");
    for (const difference of differences) {
      console.error(`  ${CHECK_LABELS[difference.kind]}${difference.file}`);
    }
    console.error("\n`pnpm run articles:build` を走らせて、生成物ごとコミットしてください。");
    process.exitCode = 1;
    return;
  }

  const written = writePages(repoRoot, pages);
  console.log(
    `✔ 記事を生成しました (${pages.size - 1}本${drafts > 0 ? ` + 下書き${drafts}本` : ""})`,
  );
  for (const difference of written)
    console.log(`  ${BUILD_LABELS[difference.kind]}${difference.file}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(resolve(process.argv[1]), resolve(import.meta.dirname, "build-articles.ts")) === "";

if (invokedDirectly) main();
