// Renders figures straight from the measured output.
//
// It draws the JSON the model actually wrote, not a model answer.
// One passing run is picked and put through solve() -> render(), so the figures here
// are exactly what the senpai wrote on the spot.
//
//   node gallery.mjs > gallery.html
//
// The output is a fragment for pasting into wireframe_board_v2.html.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PROBLEMS } from "./problems.mjs";
import { render } from "./render.mjs";
import { solve } from "./solver.mjs";

const OUT = new URL("./out/", import.meta.url);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function firstArray(t) {
  const s = t.indexOf("[");
  if (s < 0) return null;
  let depth = 0;
  let inStr = false;
  let escd = false;
  for (let i = s; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (escd) escd = false;
      else if (c === "\\") escd = true;
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

const files = existsSync(OUT) ? readdirSync(OUT).filter((n) => n.endsWith(".txt")) : [];
const cards = [];
const missing = [];

for (const p of PROBLEMS) {
  // Look at Sonnet first (show the better performer's real output). Haiku if absent.
  const cands = ["sonnet", "haiku"].flatMap((m) =>
    files
      .filter((n) => n.startsWith(`${m}__${p.id}__`))
      .sort()
      .map((n) => ({ model: m, file: n })),
  );

  let hit = null;
  for (const c of cands) {
    const raw = readFileSync(new URL(c.file, OUT), "utf8").trim();
    if (!raw || /^API Error:/m.test(raw) || raw.includes("__CLI_FAILED__")) continue;
    const body = firstArray(raw);
    if (!body) continue;
    let items;
    try {
      items = JSON.parse(body);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    try {
      const r = solve(items);
      const v = p.check(r);
      if (!v.ok) continue;
      hit = { ...c, items, r, why: v.why, raw: body };
      break;
    } catch {
      /* look at the next run */
    }
  }

  if (!hit) {
    missing.push(p.id);
    continue;
  }

  const svg = render(hit.r);
  const src = JSON.stringify(hit.items, null, 1)
    .replace(/\n\s+/g, " ")
    .replace(/\{ /g, "{")
    .replace(/ \}/g, "}")
    .replace(/\},\{/g, "},\n{");
  cards.push(
    `  <figure class="fig-card"${p.probe ? ' data-probe="1"' : ""}>\n    <figcaption><b>${esc(p.tag)}</b><span>${esc(p.unit || "")}</span></figcaption>\n    <div class="fig-stage">${svg}</div>\n    <p class="fig-q">${esc(p.prompt)}</p>\n    <details><summary>${hit.model} が書いた JSON</summary><pre>${esc(src)}</pre></details>\n    <p class="fig-ok">✔ ${esc(hit.why)}</p>\n  </figure>`,
  );
}

process.stdout.write(`${cards.join("\n")}\n`);
if (missing.length) process.stderr.write(`絵にできなかった: ${missing.join(", ")}\n`);
process.stderr.write(`${cards.length}/${PROBLEMS.length} 枚\n`);
