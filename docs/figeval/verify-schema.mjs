// Confirms a new schema does not reject the stored measured output.
//
// Adding to the contract later and rejecting a form that used to pass invalidates all
// 240 measurements. Always run this after adding something.
//
//   node docs/figeval/verify-schema.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parseFigure } from "../../packages/figure/src/schema.ts";

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

const dir = new URL("./out/", import.meta.url);
if (!existsSync(dir)) {
  console.log("out/ が無いので飛ばす(先に run.sh を回す)");
  process.exit(0);
}

let checked = 0;
const rejected = [];
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
  checked++;
  const r = parseFigure(items);
  if (!r.ok) rejected.push(`${f}: ${r.errors[0]}`);
}

console.log(`検査した出力: ${checked} 件`);
console.log(`スキーマが弾いた: ${rejected.length} 件`);
for (const r of rejected.slice(0, 15)) console.log(`  ${r}`);
if (rejected.length > 15) console.log(`  …ほか ${rejected.length - 15} 件`);
process.exitCode = rejected.length ? 1 : 0;
