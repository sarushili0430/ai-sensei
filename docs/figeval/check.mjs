import { readFileSync, readdirSync } from 'node:fs';
import { solve } from './solver.mjs';
import { PROBLEMS } from './problems.mjs';

const OUT = new URL('./out/', import.meta.url);
const byId = Object.fromEntries(PROBLEMS.map((p) => [p.id, p]));

// 失敗を3段に分ける。**「描けた/描けない」ではなく、どこで落ちたか**が知りたい。
//   json   … JSON として読めない
//   vocab  … 読めるが語彙が違う・未定義の点を使う(=図が出ない)
//   wrong  … 図は出るが**幾何が間違っている**(いちばん危ない)
//   ok     … 不変量まで通った
const rows = [];
for (const f of readdirSync(OUT).filter((n) => n.endsWith('.txt')).sort()) {
  const [model, id, trial] = f.replace(/\.txt$/, '').split('__');
  const raw = readFileSync(new URL(f, OUT), 'utf8').trim();
  const row = { model, id, trial, tag: byId[id]?.tag, bytes: raw.length };
  // 空ファイル = まだ走っている。**失敗と数えない**(数えると成功率が嘘になる)
  if (!raw) { continue; }
  if (raw.includes('__CLI_FAILED__')) { rows.push({ ...row, level: 'json', why: 'CLI が失敗' }); continue; }

  // **2通りで採点する。**
  //   strict … 出てきた文字がそのまま JSON。運用ではこれをそのまま流したい
  //   repair … 説明やフェンス、2個目の配列を落として**最初の配列だけ**拾う
  // どちらで通ったかを分けておかないと、「直せば動く」を「動く」と読み違える。
  let items = null, repaired = false, why = '';
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) items = v; else { repaired = true; why = '配列でなくオブジェクト'; }
  } catch (err) { repaired = true; why = String(err.message).slice(0, 70); }

  if (items === null) {
    const body = (raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw])[1];
    const first = firstArray(body) ?? firstArray(raw);
    if (first === null) { rows.push({ ...row, level: 'json', why }); continue; }
    try {
      const v = JSON.parse(first);
      if (!Array.isArray(v)) { rows.push({ ...row, level: 'json', why: '配列でない' }); continue; }
      items = v;
    } catch { rows.push({ ...row, level: 'json', why }); continue; }
  }

  let r;
  try { r = solve(items); } catch (err) { rows.push({ ...row, level: 'vocab', why: err.message.slice(0, 90), repaired }); continue; }

  let v;
  try { v = byId[id].check(r); } catch (err) { v = { ok: false, why: '判定中に例外: ' + err.message.slice(0, 60) }; }
  rows.push({ ...row, level: v.ok ? 'ok' : 'wrong', why: v.why, repaired, n: items.length });
}

// 最初の「対応が取れた」配列だけを切り出す(文字列の中の括弧は数えない)
function firstArray(t) {
  if (!t) return null;
  const s = t.indexOf('[');
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return t.slice(s, i + 1); }
  }
  return null;
}

const models = [...new Set(rows.map((r) => r.model))];
const LV = ['ok', 'wrong', 'vocab', 'json'];
const MARK = { ok: '○', wrong: '×図', vocab: '×語', json: '×J' };

console.log('\n=== 問題別 ===');
const w = Math.max(...PROBLEMS.map((p) => p.id.length));
console.log('問題'.padEnd(w + 2) + models.map((m) => m.padEnd(14)).join('') + ' 分類');
for (const p of PROBLEMS) {
  const cells = models.map((m) => {
    const rs = rows.filter((x) => x.model === m && x.id === p.id).sort((a, b) => a.trial - b.trial);
    return rs.map((x) => MARK[x.level]).join(' ').padEnd(14);
  });
  console.log(p.id.padEnd(w + 2) + cells.join('') + ' ' + p.tag);
}

console.log('\n=== 合計 ===');
for (const m of models) {
  const rs = rows.filter((x) => x.model === m);
  const c = Object.fromEntries(LV.map((l) => [l, rs.filter((x) => x.level === l).length]));
  const strict = rs.filter((x) => x.level === 'ok' && !x.repaired).length;
  console.log(`${m.padEnd(8)} n=${rs.length}  ○ ${c.ok}  ×図 ${c.wrong}  ×語 ${c.vocab}  ×JSON ${c.json}`);
  console.log(`         そのまま流せた      ${strict}/${rs.length} = ${(100 * strict / rs.length).toFixed(0)}%`);
  console.log(`         拾い直せば通った    ${c.ok}/${rs.length} = ${(100 * c.ok / rs.length).toFixed(0)}%`);
  console.log(`         図が黙って間違い    ${c.wrong}/${rs.length} = ${(100 * c.wrong / rs.length).toFixed(0)}%`);
}

console.log('\n=== 失敗の中身 ===');
for (const r of rows.filter((x) => x.level !== 'ok')) {
  console.log(`${r.model.padEnd(7)} ${r.id.padEnd(9)} #${r.trial} [${r.level}] ${r.why}`);
}
