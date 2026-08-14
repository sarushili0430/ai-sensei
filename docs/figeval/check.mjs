import { readFileSync, readdirSync } from "node:fs";
import { PROBLEMS } from "./problems.mjs";
import { solve } from "./solver.mjs";

const OUT = new URL("./out/", import.meta.url);
const byId = Object.fromEntries(PROBLEMS.map((p) => [p.id, p]));

// Failures split into three tiers. What matters is where it failed, not "drew / did not draw".
//   json   ... unreadable as JSON
//   vocab  ... readable, but the vocabulary is wrong or an undefined point is used (= no figure)
//   wrong  ... a figure appears but the geometry is wrong (the most dangerous)
//   ok     ... passed even the invariants
const rows = [];
for (const f of readdirSync(OUT)
  .filter((n) => n.endsWith(".txt"))
  .sort()) {
  const [model, id, trial] = f.replace(/\.txt$/, "").split("__");
  const raw = readFileSync(new URL(f, OUT), "utf8").trim();
  const row = { model, id, trial, tag: byId[id]?.tag, bytes: raw.length };
  // An empty file means it is still running. Not counted as a failure (counting it would make the success rate a lie)
  if (!raw) {
    continue;
  }
  // Do not mix transport failures into model failures. They leave the denominator and
  // are reported separately. The CLI sometimes emits "API Error: ..." as the body -
  // that is a transport failure too. Distinguishing by "is there content" would count
  // an error message as the model's answer.
  if (raw.includes("__CLI_FAILED__") || /^API Error:/m.test(raw)) {
    rows.push({ ...row, level: "cli", why: raw.split("\n")[0].slice(0, 70) });
    continue;
  }

  // Scored two ways.
  //   strict ... the emitted text is JSON as-is. In production we want to use it directly
  //   repair ... drop the prose, fences and any second array, and take only the first array
  // Without separating which one passed, "works if you fix it" reads as "works".
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

  let v;
  try {
    v = byId[id].check(r);
  } catch (err) {
    v = { ok: false, why: `判定中に例外: ${err.message.slice(0, 60)}` };
  }
  rows.push({ ...row, level: v.ok ? "ok" : "wrong", why: v.why, repaired, n: items.length });
}

// Cut out only the first balanced array (brackets inside strings are not counted)
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

console.log("\n=== 問題別 ===");
const w = Math.max(...PROBLEMS.map((p) => p.id.length));
console.log(`${"問題".padEnd(w + 2) + models.map((m) => m.padEnd(12)).join("")}単元 / 分類`);
for (const p of PROBLEMS) {
  const cells = models.map((m) => {
    const rs = rows.filter((x) => x.model === m && x.id === p.id).sort((a, b) => a.trial - b.trial);
    return rs
      .map((x) => MARK[x.level])
      .join(" ")
      .padEnd(12);
  });
  console.log(p.id.padEnd(w + 2) + cells.join("") + (p.unit ? `${p.unit} / ` : "") + p.tag);
}

// Unit coverage: whether that unit's figure was ever drawn correctly.
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
}

console.log("\n=== 失敗の中身 ===");
for (const r of rows.filter((x) => x.level !== "ok")) {
  console.log(`${r.model.padEnd(7)} ${r.id.padEnd(9)} #${r.trial} [${r.level}] ${r.why}`);
}
