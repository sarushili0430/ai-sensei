// Confirms the port did not break anything, using the stored measured output.
//
// It feeds the same input to docs/figeval/solver.mjs (used for the measurements) and
// packages/figure/src/solve.js (the production copy) and checks every solved
// coordinate matches.
// Twenty unit tests cannot vouch for a 1000-line rewrite.
//
//   node --experimental-strip-types docs/figeval/verify-port.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { solve as after } from "../../packages/figure/src/solve.js";
import { solve as before } from "./solver.mjs";

function firstArray(t) {
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

/** Folds a solved result into a comparable form. */
function shape(result) {
  return JSON.stringify({
    pts: Object.fromEntries(
      Object.entries(result.pts).map(([k, p]) => [
        k,
        [Math.round(p.x * 1e9), Math.round(p.y * 1e9)],
      ]),
    ),
    draws: result.draws.map((d) => d.t),
  });
}

const dir = new URL("./out/", import.meta.url);
if (!existsSync(dir)) {
  console.log("out/ が無いので飛ばす(先に run.sh を回す)");
  process.exit(0);
}

let same = 0;
let bothThrew = 0;
const differ = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith(".txt"))) {
  const raw = readFileSync(new URL(f, dir), "utf8").trim();
  if (!raw || /^API Error:/m.test(raw) || raw.includes("__CLI_FAILED__")) continue;
  const body = firstArray(raw);
  if (!body) continue;
  let items;
  try {
    items = JSON.parse(body);
  } catch {
    continue;
  }
  if (!Array.isArray(items) || !items.length) continue;

  let a;
  let b;
  let ea = null;
  let eb = null;
  try {
    a = shape(before(structuredClone(items)));
  } catch (error) {
    ea = error.message;
  }
  try {
    b = shape(after(structuredClone(items)));
  } catch (error) {
    eb = error.message;
  }
  if (ea && eb) {
    if (ea === eb) bothThrew++;
    else differ.push(`${f}: 例外の文言が違う\n    前: ${ea}\n    後: ${eb}`);
    continue;
  }
  if (ea || eb) {
    differ.push(`${f}: 片方だけ落ちた(前=${ea ?? "OK"} / 後=${eb ?? "OK"})`);
    continue;
  }
  if (a === b) same++;
  else differ.push(`${f}: 解いた座標が違う`);
}

console.log(`一致: ${same} 件 / 同じ理由で落ちた: ${bothThrew} 件`);
console.log(`食い違い: ${differ.length} 件`);
for (const d of differ.slice(0, 10)) console.log(`  ${d}`);
process.exitCode = differ.length ? 1 : 0;
