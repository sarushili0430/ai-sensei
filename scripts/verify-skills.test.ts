import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_ROOTS, checkSkills, parseSkillFrontMatter } from "./verify-skills.ts";

const SKILL = `---
name: post-article
description: 記事を投稿するときに使う。
---

# 記事を投稿する
`;

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** 両方の置き場に同じ中身を置いた、正しい形。 */
function paired(content = SKILL, name = "post-article"): Record<string, string> {
  return Object.fromEntries(SKILL_ROOTS.map((root) => [`${root}/${name}/SKILL.md`, content]));
}

describe("スキルの置き場", () => {
  it("2箇所の中身が同じなら通す", () => {
    expect(checkSkills(workspace(paired()))).toEqual([]);
  });

  it("片方だけ直したら落ちる(いちばん起きやすいずれ)", () => {
    const files = paired();
    files[`${SKILL_ROOTS[1]}/post-article/SKILL.md`] = `${SKILL}\n手順を1行足した。\n`;

    expect(checkSkills(workspace(files))).toEqual([
      { skill: "post-article", message: expect.stringContaining("中身が違います") },
    ]);
  });

  it("片方にしか置いていないと落ちる", () => {
    const root = workspace(paired());
    rmSync(join(root, SKILL_ROOTS[1], "post-article", "SKILL.md"));

    expect(checkSkills(root)).toEqual([
      { skill: "post-article", message: expect.stringContaining("がありません") },
    ]);
  });

  it("front matter の name がディレクトリ名と違うと落ちる", () => {
    const problems = checkSkills(workspace(paired(SKILL.replace("post-article", "post_article"))));

    expect(problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining("name がディレクトリ名と違います"),
    ]);
  });

  it("description が空だと落ちる(空だと呼ばれない)", () => {
    const problems = checkSkills(
      workspace(paired(SKILL.replace("記事を投稿するときに使う。", ""))),
    );

    expect(problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining("description が空です"),
    ]);
  });

  it("スキルが1つも無いと落ちる(置き場を消した事故に気づく)", () => {
    expect(checkSkills(workspace({ "README.md": "" }))).toEqual([
      { skill: "(なし)", message: expect.stringContaining("スキルがありません") },
    ]);
  });
});

describe("front matter", () => {
  it("閉じていないと読まない", () => {
    expect(parseSkillFrontMatter("---\nname: a\n")).toBeNull();
    expect(parseSkillFrontMatter("# 見出しから始まる\n")).toBeNull();
  });

  it("項目を読む", () => {
    expect(parseSkillFrontMatter(SKILL)?.get("name")).toBe("post-article");
  });
});
