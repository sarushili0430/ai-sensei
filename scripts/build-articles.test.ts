import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Article,
  ArticleError,
  OUTPUT_DIR,
  buildPages,
  collectArticles,
  diffPages,
  formatDate,
  parseFrontMatter,
  publishedArticles,
  renderArticlePage,
  renderIndexPage,
  renderInline,
  renderMarkdown,
  writePages,
} from "./build-articles.ts";

const FRONT_MATTER = `---
title: 教え返しの話
description: 教わったその場で説明してもらう理由。
date: 2026-08-20
---
`;

function article(body: string, slug = "teach-back"): Article {
  return parseFrontMatter(`apps/lp/articles/${slug}.md`, slug, FRONT_MATTER + body);
}

function render(body: string): string {
  const parsed = article(body);
  return renderMarkdown("apps/lp/articles/teach-back.md", parsed.markdown, parsed.bodyOffset).html;
}

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "articles-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("front matter", () => {
  it("必要な項目を読む", () => {
    const parsed = article("本文。\n");

    expect(parsed.title).toBe("教え返しの話");
    expect(parsed.date).toBe("2026-08-20");
    expect(parsed.updated).toBeNull();
    expect(parsed.draft).toBe(false);
  });

  it("知らない項目で落ちる(綴り間違いを黙って捨てない)", () => {
    const source = FRONT_MATTER.replace("date:", "published:");

    expect(() => parseFrontMatter("a.md", "a", source)).toThrow(/知らない項目/);
  });

  it("実在しない日付で落ちる", () => {
    const source = FRONT_MATTER.replace("2026-08-20", "2026-02-31");

    expect(() => parseFrontMatter("a.md", "a", source)).toThrow(/実在しない日付/);
  });

  it("description が160文字を超えると落ちる(検索結果で切れる)", () => {
    const source = FRONT_MATTER.replace("教わったその場で説明してもらう理由。", "あ".repeat(161));

    expect(() => parseFrontMatter("a.md", "a", source)).toThrow(/description が長すぎます/);
  });

  it("URLに使えないファイル名で落ちる", () => {
    expect(() => parseFrontMatter("教え返し.md", "教え返し", FRONT_MATTER)).toThrow(/ファイル名/);
  });

  it("updated が date より前だと落ちる", () => {
    const source = FRONT_MATTER.replace(
      "date: 2026-08-20",
      "date: 2026-08-20\nupdated: 2026-08-19",
    );

    expect(() => parseFrontMatter("a.md", "a", source)).toThrow(/updated が date より前/);
  });
});

describe("本文", () => {
  it("見出しに飛べるidを振る", () => {
    expect(render("## ひとつめ\n\n### 中\n\n## ふたつめ\n")).toBe(
      '<h2 id="s1">ひとつめ</h2>\n\n<h3 id="s1-1">中</h3>\n\n<h2 id="s2">ふたつめ</h2>',
    );
  });

  it("段落の中の改行を潰す(日本語は詰めて、英語は空白1つ)", () => {
    expect(render("いち。\nに。\n\nさん。\n")).toBe("<p>いち。に。</p>\n\n<p>さん。</p>");
    expect(render("self-explanation\neffect\n")).toBe("<p>self-explanation effect</p>");
  });

  it("繋ぎ目のタグを外してから、日本語かどうかを見る", () => {
    // 次の行が `**` で始まっても、空白が入らない(入ると「、 理解」に見える)
    expect(render("起きているのは、\n**理解ではなく**、読めたという手応え。\n")).toBe(
      "<p>起きているのは、<strong>理解ではなく</strong>、読めたという手応え。</p>",
    );
  });

  it("箇条書きと番号つきを分ける", () => {
    expect(render("- あ\n- い\n")).toBe("<ul>\n  <li>あ</li>\n  <li>い</li>\n</ul>");
    expect(render("1. あ\n2. い\n")).toBe("<ol>\n  <li>あ</li>\n  <li>い</li>\n</ol>");
  });

  it("引用をまとめて1つにする", () => {
    expect(render("> あ。\n> い。\n")).toBe("<blockquote>\n  <p>あ。い。</p>\n</blockquote>");
  });

  it("落ちた行を、元ファイルの行番号で指す", () => {
    // front matter が5行なので、本文2行目 = ファイルの7行目
    try {
      render("ふつうの段落。\n# 見出し\n");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArticleError);
      expect((error as ArticleError).line).toBe(7);
    }
  });

  it.each([
    ["# 題", /front matter の title/],
    ["#### 小さい見出し", /2段まで/],
    ["```js", /コードブロック/],
    ["| a | b |", /表は書けません/],
    ["![図](a.png)", /画像は置けません/],
    ["  字下げ", /行頭に空白/],
    ["---", /区切り線/],
    ["<div>素のHTML</div>", /生のHTML/],
  ])("読めない記法 %s を落とす", (line, reason) => {
    expect(() => render(`${line}\n`)).toThrow(reason);
  });

  it("`## ` より先に `### ` を置けない", () => {
    expect(() => render("### 小見出し\n")).toThrow(/`## ` が要ります/);
  });
});

describe("インライン", () => {
  it("強調・マーカー・コード・リンクだけを変換する", () => {
    expect(renderInline("a.md", 1, "**強** ==印== `code` [文字](https://example.com/)")).toBe(
      '<strong>強</strong> <span class="mk">印</span> <code>code</code>' +
        ' <a href="https://example.com/">文字</a>',
    );
  });

  it("記法でない文字はそのまま出す", () => {
    expect(renderInline("a.md", 1, "1 < 2 & 3 > 2")).toBe("1 &lt; 2 &amp; 3 &gt; 2");
  });

  it("タグを書いても文字として出す(コードの中も同じ)", () => {
    expect(renderInline("a.md", 1, "`<script>`")).toBe("<code>&lt;script&gt;</code>");
  });

  it("飛べない先のリンクで落ちる", () => {
    expect(() => renderInline("a.md", 3, "[押す](javascript:alert(1))")).toThrow(/リンク先/);
  });

  it("相対パスと見出しへのリンクは通す", () => {
    expect(renderInline("a.md", 1, "[上](../../)")).toBe('<a href="../../">上</a>');
    expect(renderInline("a.md", 1, "[中](#s1)")).toBe('<a href="#s1">中</a>');
  });
});

describe("ページ", () => {
  it("題と要約をOGPにも入れる", () => {
    const html = renderArticlePage(article("本文。\n"));

    expect(html).toContain("<title>教え返しの話 — カタルテ</title>");
    expect(html).toContain('<meta property="og:title" content="教え返しの話">');
    expect(html).toContain('<meta property="article:published_time" content="2026-08-20">');
    expect(html).toContain('<link rel="stylesheet" href="../../styles.css">');
  });

  it("見出しが3本以上のときだけ目次を出す", () => {
    expect(renderArticlePage(article("## あ\n\n## い\n"))).not.toContain("article-toc");
    expect(renderArticlePage(article("## あ\n\n## い\n\n## う\n"))).toContain("article-toc");
  });

  it("改稿日は、入れたときだけ出す", () => {
    const updated = parseFrontMatter(
      "apps/lp/articles/a.md",
      "a",
      `${FRONT_MATTER.replace("date: 2026-08-20", "date: 2026-08-20\nupdated: 2026-09-01")}本文。\n`,
    );

    expect(renderArticlePage(article("本文。\n"))).not.toContain("更新");
    expect(renderArticlePage(updated)).toContain("2026年9月1日</time> 更新");
  });

  it("一覧は新しい順に並べ、1本も無ければ検索に載せない", () => {
    expect(renderIndexPage([])).toContain('<meta name="robots" content="noindex">');
    expect(renderIndexPage([])).toContain("まだ記事はありません");

    const old = article("本文。\n", "old");
    const recent = parseFrontMatter(
      "apps/lp/articles/new.md",
      "new",
      `${FRONT_MATTER.replace("2026-08-20", "2026-09-01")}本文。\n`,
    );
    const html = renderIndexPage(publishedArticles([old, recent]));

    expect(html).not.toContain("noindex");
    expect(html.indexOf('href="./new/"')).toBeLessThan(html.indexOf('href="./old/"'));
  });
});

describe("生成物との突き合わせ", () => {
  const source = `${FRONT_MATTER}本文。\n`;

  it("下書きは生成しない", () => {
    const draft = parseFrontMatter(
      "apps/lp/articles/a.md",
      "a",
      `${FRONT_MATTER.replace("date: 2026-08-20", "date: 2026-08-20\ndraft: true")}本文。\n`,
    );

    expect([...buildPages([draft]).keys()]).toEqual([`${OUTPUT_DIR}/index.html`]);
  });

  it("記事を消すと、生成物も片付く", () => {
    const root = workspace({ "apps/lp/articles/gone.md": source });
    writePages(root, buildPages(collectArticles(root).articles));
    expect(readdirSync(join(root, OUTPUT_DIR))).toContain("gone");

    rmSync(join(root, "apps/lp/articles/gone.md"));
    writePages(root, buildPages(collectArticles(root).articles));

    expect(readdirSync(join(root, OUTPUT_DIR))).toEqual(["index.html"]);
  });

  it("読めない記事があっても、そこで止めずに理由をためる", () => {
    const root = workspace({
      "apps/lp/articles/ok.md": source,
      "apps/lp/articles/broken.md": "front matter が無い\n",
      "apps/lp/articles/README.md": "# 書き方(記事ではない)\n",
    });

    const { articles, problems } = collectArticles(root);

    expect(articles.map((entry) => entry.slug)).toEqual(["ok"]);
    expect(problems.map((problem) => problem.file)).toEqual(["apps/lp/articles/broken.md"]);
  });

  it("生成物が古いと --check が気づく", () => {
    const root = workspace({ "apps/lp/articles/a.md": source });
    const pages = buildPages(collectArticles(root).articles);

    expect(diffPages(root, pages).map((difference) => difference.kind)).toEqual([
      "missing",
      "missing",
    ]);

    writePages(root, pages);
    expect(diffPages(root, pages)).toEqual([]);

    writeFileSync(join(root, `${OUTPUT_DIR}/a/index.html`), "手で書き足した");
    expect(diffPages(root, pages)).toEqual([{ kind: "stale", file: `${OUTPUT_DIR}/a/index.html` }]);
  });

  it("生成物以外のファイルは、生成の巻き添えにしない", () => {
    const root = workspace({
      "apps/lp/articles/a.md": source,
      "apps/lp/public/articles/og.png": "画像のつもり",
    });
    writePages(root, buildPages(collectArticles(root).articles));

    expect(readFileSync(join(root, "apps/lp/public/articles/og.png"), "utf8")).toBe("画像のつもり");
  });
});

describe("日付", () => {
  it("0詰めを外して出す", () => {
    expect(formatDate("2026-08-01")).toBe("2026年8月1日");
  });
});
