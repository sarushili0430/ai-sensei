import { readFileSync, readdirSync } from "node:fs";
import { lintFigure, repairFigure } from "../../packages/figure/src/quality.js";
import { PROBLEMS, READABILITY_FIXTURES, READABLE_FIGURE_FIXTURE } from "./problems.mjs";
import { solve } from "./solver.mjs";

const OUT = new URL("./out/", import.meta.url);
const byId = Object.fromEntries(PROBLEMS.map((p) => [p.id, p]));

// 失敗を3段に分ける。**「描けた/描けない」ではなく、どこで落ちたか**が知りたい。
//   json   … JSON として読めない
//   vocab  … 読めるが語彙が違う・未定義の点を使う(=図が出ない)
//   wrong  … 図は出るが**幾何が間違っている**(いちばん危ない)
//   ok     … 不変量まで通った
const rows = [];
for (const f of readdirSync(OUT)
  .filter((n) => n.endsWith(".txt"))
  .sort()) {
  const [model, id, trial] = f.replace(/\.txt$/, "").split("__");
  const raw = readFileSync(new URL(f, OUT), "utf8").trim();
  const row = { model, id, trial, tag: byId[id]?.tag, bytes: raw.length };
  // 空ファイル = まだ走っている。**失敗と数えない**(数えると成功率が嘘になる)
  if (!raw) {
    continue;
  }
  // **通信の失敗をモデルの失敗に混ぜない。**分母から外し、件数だけ別に出す。
  // CLI が本文として "API Error: ..." を吐くことがある。**これも通信の失敗。**
  // 中身があるかどうかで見分けると、エラー文をモデルの回答として数えてしまう。
  if (
    raw.includes("__CLI_FAILED__") ||
    /^API Error:/m.test(raw) ||
    /^(Not logged in|Authentication required)/m.test(raw)
  ) {
    rows.push({ ...row, level: "cli", why: raw.split("\n")[0].slice(0, 70) });
    continue;
  }

  // **2通りで採点する。**
  //   strict … 出てきた文字がそのまま JSON。運用ではこれをそのまま流したい
  //   repair … 説明やフェンス、2個目の配列を落として**最初の配列だけ**拾う
  // どちらで通ったかを分けておかないと、「直せば動く」を「動く」と読み違える。
  let items = null;
  let repaired = false;
  let why = "";
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) items = v;
    else {
      repaired = true;
      why = "配列でなくオブジェクト";
    }
  } catch (err) {
    repaired = true;
    why = String(err.message).slice(0, 70);
  }

  if (items === null) {
    const body = (raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw])[1];
    const first = firstArray(body) ?? firstArray(raw);
    if (first === null) {
      rows.push({ ...row, level: "json", why });
      continue;
    }
    try {
      const v = JSON.parse(first);
      if (!Array.isArray(v)) {
        rows.push({ ...row, level: "json", why: "配列でない" });
        continue;
      }
      items = v;
    } catch {
      rows.push({ ...row, level: "json", why });
      continue;
    }
  }

  let r;
  try {
    r = solve(items);
  } catch (err) {
    rows.push({ ...row, level: "vocab", why: err.message.slice(0, 90), repaired });
    continue;
  }

  // 幾何の正誤とは別に、**本番と同じ自動修正後**の可読性を測る。
  // 正しいが崩れた図を `wrong` に混ぜると、語彙の正しさとレイアウト品質を取り違える。
  let readability;
  try {
    const repairedFigure = repairFigure(items);
    readability = {
      ok: repairedFigure.ok,
      repaired: repairedFigure.ok && repairedFigure.repaired,
      why: repairedFigure.ok
        ? repairedFigure.repaired
          ? `自動修正: ${repairedFigure.changes.join(",")}`
          : "可読性lint通過"
        : repairedFigure.quality.issues.map((issue) => issue.message).join(" / "),
    };
  } catch (err) {
    readability = { ok: false, repaired: false, why: `可読性判定中に例外: ${err.message}` };
  }

  let v;
  try {
    v = byId[id].check(r);
  } catch (err) {
    v = { ok: false, why: `判定中に例外: ${err.message.slice(0, 60)}` };
  }
  rows.push({
    ...row,
    level: v.ok ? "ok" : "wrong",
    why: v.why,
    repaired,
    readability,
    n: items.length,
  });
}

// 最初の「対応が取れた」配列だけを切り出す(文字列の中の括弧は数えない)
function firstArray(t) {
  if (!t) return null;
  const s = t.indexOf("[");
  if (s < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = s; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return t.slice(s, i + 1);
    }
  }
  return null;
}

const models = [...new Set(rows.map((r) => r.model))];
const LV = ["ok", "wrong", "vocab", "json"];
const MARK = { ok: "○", wrong: "×図", vocab: "×語", json: "×J", cli: "–" };
const markOf = (row) =>
  row.level === "ok" && row.readability?.ok === false ? "○崩" : MARK[row.level];

console.log("\n=== 可読性fixture ===");
for (const fixture of READABILITY_FIXTURES) {
  const before = lintFigure(solve(fixture.items));
  const repaired = repairFigure(fixture.items);
  const detected = before.issues.some((issue) => issue.invariant === fixture.invariant);
  if (!detected || !repaired.ok) {
    throw new Error(
      `${fixture.id}: ${fixture.invariant} の検出または自動修正に失敗 ` +
        `(before=${before.issues.map((issue) => issue.invariant).join(",")}, after=${repaired.quality.issues.map((issue) => issue.invariant).join(",")})`,
    );
  }
  console.log(`${fixture.id.padEnd(20)} ${fixture.invariant.padEnd(18)} 検出 → 修正済み`);
}
const readableFixture = lintFigure(solve(READABLE_FIGURE_FIXTURE));
if (!readableFixture.ok) {
  throw new Error(
    `正常fixtureが可読性lintに落ちた: ${readableFixture.issues.map((issue) => issue.message)}`,
  );
}
console.log("readable_triangle    false-positiveなし");

console.log("\n=== 問題別 ===");
const w = Math.max(...PROBLEMS.map((p) => p.id.length));
console.log(`${"問題".padEnd(w + 2) + models.map((m) => m.padEnd(12)).join("")}単元 / 分類`);
for (const p of PROBLEMS) {
  const cells = models.map((m) => {
    const rs = rows.filter((x) => x.model === m && x.id === p.id).sort((a, b) => a.trial - b.trial);
    return rs.map(markOf).join(" ").padEnd(12);
  });
  console.log(p.id.padEnd(w + 2) + cells.join("") + (p.unit ? `${p.unit} / ` : "") + p.tag);
}

// **単元カバレッジ。**「その単元の図が、一度でも正しく描けたか」を出す。
console.log("\n=== 単元カバレッジ(1回でも○になったか) ===");
const covered = [];
const notYet = [];
for (const p of PROBLEMS) {
  const rs = rows.filter((x) => x.id === p.id && x.level !== "cli");
  if (!rs.length) continue;
  (rs.some((x) => x.level === "ok") ? covered : notYet).push(p);
}
console.log(`到達 ${covered.length}/${covered.length + notYet.length} 種類`);
if (notYet.length) notYet.forEach((p) => console.log(`  まだ: ${p.id} (${p.unit || ""} ${p.tag})`));

console.log("\n=== 合計 ===");
for (const m of models) {
  const all = rows.filter((x) => x.model === m);
  const cli = all.filter((x) => x.level === "cli").length;
  const rs = all.filter((x) => x.level !== "cli");
  if (!rs.length) {
    console.log(`${m.padEnd(8)} 有効な回答なし(通信失敗 ${cli} 件)`);
    continue;
  }
  const c = Object.fromEntries(LV.map((l) => [l, rs.filter((x) => x.level === l).length]));
  const strict = rs.filter((x) => x.level === "ok" && !x.repaired).length;
  // JSON/語彙で落ちた回答を可読性の分母へ混ぜない。図まで解けた回答だけの独立軸にする。
  const figures = rs.filter((x) => x.readability !== undefined);
  const readable = figures.filter((x) => x.readability.ok === true).length;
  const autoFixed = figures.filter(
    (x) => x.readability.ok === true && x.readability.repaired,
  ).length;
  const correctButBroken = rs.filter((x) => x.level === "ok" && x.readability?.ok === false).length;
  if (cli) console.log(`${m.padEnd(8)} (通信失敗 ${cli} 件は分母から除外)`);
  console.log(
    `${m.padEnd(8)} n=${rs.length}  ○ ${c.ok}  ×図 ${c.wrong}  ×語 ${c.vocab}  ×JSON ${c.json}`,
  );
  console.log(
    `         そのまま流せた      ${strict}/${rs.length} = ${((100 * strict) / rs.length).toFixed(0)}%`,
  );
  console.log(
    `         拾い直せば通った    ${c.ok}/${rs.length} = ${((100 * c.ok) / rs.length).toFixed(0)}%`,
  );
  console.log(
    `         図が黙って間違い    ${c.wrong}/${rs.length} = ${((100 * c.wrong) / rs.length).toFixed(0)}%`,
  );
  if (figures.length > 0) {
    console.log(
      `         可読性lint通過       ${readable}/${figures.length} = ${((100 * readable) / figures.length).toFixed(0)}% (自動修正 ${autoFixed})`,
    );
  } else console.log("         可読性lint通過       図まで解けた回答なし");
  console.log(`         ○だが崩れ           ${correctButBroken}/${rs.length}`);
}

console.log("\n=== 失敗の中身 ===");
for (const r of rows.filter((x) => x.level !== "ok" || x.readability?.ok === false)) {
  const readability = r.readability?.ok === false ? ` / [崩れ] ${r.readability.why}` : "";
  console.log(
    `${r.model.padEnd(7)} ${r.id.padEnd(9)} #${r.trial} [${r.level}] ${r.why}${readability}`,
  );
}
