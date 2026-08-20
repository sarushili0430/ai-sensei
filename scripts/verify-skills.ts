/**
 * Codex と Claude Code が読むスキルが、1文字までずれていないことを見る。
 *
 * **同じ手順書を2箇所に置いている。** 読み込み先はエージェントごとに決まっていて
 * (Codexは `.agents/skills/`、Claude Codeは `.claude/skills/`)片方に寄せられない。
 * ただし2箇所に散った手順は必ず片方だけ古くなるので(`apps/lp/README.md` の
 * 「両方に書くと必ず片方が古くなる」と同じ話)、**コピーを置いて、ずれたらここで落とす**。
 *
 * symlinkで1本にする手もあるが、辿るかどうかが読む側の実装しだいで、
 * **辿らなかったときはスキルが黙って読まれない**。落ちて分かるほうを選んでいる。
 *
 *   pnpm run verify:skills
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** スキルの置き場。左が正(コピー元)。 */
export const SKILL_ROOTS = [".agents/skills", ".claude/skills"] as const;

export type SkillProblem = { skill: string; message: string };

/** `SKILL.md` の先頭にある `---` 挟みの項目。読むのは name と description だけ。 */
export function parseSkillFrontMatter(source: string): Map<string, string> | null {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if ((lines[0] ?? "") !== "---") return null;

  const values = new Map<string, string>();
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line === "---") return values;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return null; // 閉じていない
}

/** 置き場にあるスキル名(= ディレクトリ名)。 */
export function listSkillNames(repoRoot: string, root: string): string[] {
  try {
    return readdirSync(resolve(repoRoot, root), { withFileTypes: true, encoding: "utf8" })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 両方の置き場を突き合わせる。落ちる理由は、直す場所が分かる形で返す。 */
export function checkSkills(repoRoot: string): SkillProblem[] {
  const problems: SkillProblem[] = [];
  const names = [...new Set(SKILL_ROOTS.flatMap((root) => listSkillNames(repoRoot, root)))].sort();

  if (names.length === 0) {
    return [{ skill: "(なし)", message: `${SKILL_ROOTS.join(" と ")} にスキルがありません` }];
  }

  for (const name of names) {
    const sources = new Map<string, string | null>();
    for (const root of SKILL_ROOTS) {
      const path = join(root, name, "SKILL.md");
      try {
        sources.set(root, readFileSync(resolve(repoRoot, path), "utf8"));
      } catch {
        sources.set(root, null);
        problems.push({ skill: name, message: `${path} がありません` });
      }
    }

    const [first, second] = SKILL_ROOTS;
    const left = sources.get(first) ?? null;
    const right = sources.get(second) ?? null;
    if (left === null || right === null) continue;

    if (left !== right) {
      problems.push({
        skill: name,
        message: `${first}/${name}/SKILL.md と ${second}/${name}/SKILL.md の中身が違います`,
      });
    }

    const frontMatter = parseSkillFrontMatter(left);
    if (frontMatter === null) {
      problems.push({ skill: name, message: "`---` で挟んだ front matter がありません" });
      continue;
    }
    if ((frontMatter.get("name") ?? "") !== name) {
      problems.push({
        skill: name,
        message: `front matter の name がディレクトリ名と違います: ${frontMatter.get("name") ?? "(空)"}`,
      });
    }
    if ((frontMatter.get("description") ?? "") === "") {
      problems.push({
        skill: name,
        message: "description が空です(いつ使うかを書かないと、呼ばれません)",
      });
    }
  }

  return problems;
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, "..");
  const problems = checkSkills(repoRoot);

  if (problems.length === 0) {
    const names = listSkillNames(repoRoot, SKILL_ROOTS[0]);
    console.log(`✔ スキルは2箇所で一致しています (${names.join(", ")})`);
    return;
  }

  console.error("✘ スキルの置き場がずれています:");
  for (const problem of problems) console.error(`  ${problem.skill}: ${problem.message}`);
  console.error(
    `\n正は ${SKILL_ROOTS[0]}/ です。` +
      `\`cp -r ${SKILL_ROOTS[0]}/<name> ${SKILL_ROOTS[1]}/\` でコピーしてください。`,
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(resolve(process.argv[1]), resolve(import.meta.dirname, "verify-skills.ts")) === "";

if (invokedDirectly) main();
