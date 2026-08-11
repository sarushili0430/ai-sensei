// 8問。**採点は「描けたか」ではなく「図が正しいか」**。
// どれも「作図で組み立てたときだけ成り立ち、座標を当てずっぽうで書くと崩れる」量を測る。

const deg = (a, o, b) => {
  const u = Math.atan2(a.y - o.y, a.x - o.x), v = Math.atan2(b.y - o.y, b.x - o.x);
  let d = Math.abs((u - v) * 180 / Math.PI) % 360;
  return d > 180 ? 360 - d : d;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const segs = (r) => r.draws.filter((d) => d.t === 'seg' && d.names);
const hasSeg = (r, x, y) => segs(r).some((s) => (s.names[0] === x && s.names[1] === y) || (s.names[0] === y && s.names[1] === x));
const curveOf = (r, i) => Object.values(r.curves)[i];

export const PROBLEMS = [
  {
    id: 'centroid',
    tag: '平面・基本',
    prompt: '三角形ABCの3本の中線が1点(重心G)で交わることを説明したい。その図を描いて。',
    check(r) {
      const g = Object.entries(r.pts).find(([, p]) =>
        Object.keys(r.pts).length >= 4 && p);
      // 重心の真の位置を、頂点3つから求める(名前は A,B,C を想定)
      const { A, B, C } = r.pts;
      if (!A || !B || !C) return { ok: false, why: 'A,B,C が無い' };
      const truth = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
      const hit = Object.entries(r.pts).find(([n, p]) => n !== 'A' && n !== 'B' && n !== 'C' && dist(p, truth) < 1e-6);
      if (!hit) return { ok: false, why: '重心の位置にある点が無い(=3本目が交わっていない)' };
      const medians = ['A', 'B', 'C'].filter((v) => {
        const [x, y] = ['A', 'B', 'C'].filter((o) => o !== v);
        const m = { x: (r.pts[x].x + r.pts[y].x) / 2, y: (r.pts[x].y + r.pts[y].y) / 2 };
        return segs(r).some((s) => {
          const [p, q] = [s.a, s.b];
          const on = (u, w) => dist(u, r.pts[v]) < 1e-6 && (dist(w, m) < 1e-6 || dist(w, truth) < 1e-6);
          return on(p, q) || on(q, p);
        });
      }).length;
      if (medians < 3) return { ok: false, why: `中線が ${medians}/3 本しか引かれていない` };
      return { ok: true, why: `重心一致 ${dist(hit[1], truth).toExponential(1)}、中線3本` };
    },
  },
  {
    id: 'thales',
    tag: '円・むずかしい',
    prompt: '円Oの直径をABとする。円周上の点Pについて ∠APB = 90° になることを説明したい。その図を描いて。',
    check(r) {
      const { A, B } = r.pts;
      if (!A || !B) return { ok: false, why: 'A,B が無い' };
      const K = Object.values(r.circles)[0];
      if (!K) return { ok: false, why: '円が無い' };
      if (Math.abs(dist(A, B) - 2 * K.r) > 1e-6) return { ok: false, why: 'AB が直径になっていない' };
      const P = r.pts.P || Object.entries(r.pts).find(([n, p]) => !'AB'.includes(n) && Math.abs(dist(p, K.c) - K.r) < 1e-6)?.[1];
      if (!P) return { ok: false, why: '円周上の第3の点が無い' };
      const a = deg(A, P, B);
      return Math.abs(a - 90) < 0.5
        ? { ok: true, why: `∠APB = ${a.toFixed(3)}°` }
        : { ok: false, why: `∠APB = ${a.toFixed(2)}°(90°になっていない)` };
    },
  },
  {
    id: 'tangent',
    tag: '円・接線',
    prompt: '円Oの周上に3点A,B,Cがある。点Aにおける円の接線をATとするとき、接弦定理 ∠TAB = ∠ACB を説明したい。その図を描いて。',
    check(r) {
      const { A, B, C } = r.pts;
      const K = Object.values(r.circles)[0];
      if (!A || !B || !C || !K) return { ok: false, why: 'A,B,C か円が足りない' };
      for (const [n, p] of [['A', A], ['B', B], ['C', C]]) {
        if (Math.abs(dist(p, K.c) - K.r) > 1e-6) return { ok: false, why: `${n} が円周上にない` };
      }
      const T = r.pts.T;
      if (!T) return { ok: false, why: '接点方向の点 T が無い' };
      // 接線であること = OA ⊥ AT
      const perp = deg(r.pts.O ?? K.c, A, T);
      if (Math.abs(perp - 90) > 0.5) return { ok: false, why: `AT が接線でない(OA との角 ${perp.toFixed(2)}°)` };
      const l = deg(T, A, B), rgt = deg(A, C, B);
      return Math.abs(l - rgt) < 0.5
        ? { ok: true, why: `∠TAB = ${l.toFixed(3)}°, ∠ACB = ${rgt.toFixed(3)}°` }
        : { ok: false, why: `∠TAB = ${l.toFixed(2)}° だが ∠ACB = ${rgt.toFixed(2)}°` };
    },
  },
  {
    id: 'ratio',
    tag: '平面・内分',
    prompt: '三角形ABCの辺BC上に、BD:DC = 3:2 となる点Dをとる。AとDを結ぶ。その図を描いて。',
    check(r) {
      const { A, B, C, D } = r.pts;
      if (!A || !B || !C || !D) return { ok: false, why: 'A,B,C,D が足りない' };
      const cross = Math.abs((C.x - B.x) * (D.y - B.y) - (C.y - B.y) * (D.x - B.x));
      if (cross > 1e-6) return { ok: false, why: 'D が BC 上にない' };
      const k = dist(B, D) / dist(D, C);
      if (Math.abs(k - 1.5) > 1e-6) return { ok: false, why: `BD:DC = ${k.toFixed(4)}:1(1.5:1 のはず)` };
      if (!hasSeg(r, 'A', 'D')) return { ok: false, why: 'AD が引かれていない' };
      return { ok: true, why: `BD:DC = ${k.toFixed(6)}:1、AD あり` };
    },
  },
  {
    id: 'box',
    tag: '空間',
    prompt: '直方体ABCD-EFGHがある。対角線AGを引いた図を描いて。',
    check(r) {
      const b = r.draws.find((d) => d.t === 'box3');
      if (!b) return { ok: false, why: '直方体が無い(box3 を使っていない)' };
      if (b.labels.length !== 8) return { ok: false, why: '頂点が8つない' };
      const idx = (n) => b.labels.indexOf(n);
      const diag = segs(r).find((s) => {
        const [i, j] = s.names.map(idx);
        if (i < 0 || j < 0) return false;
        return b.v3[i].every((v, k) => v !== b.v3[j][k]);   // 3方向すべて違う = 空間対角線
      });
      if (!diag) return { ok: false, why: '空間対角線が引かれていない' };
      return { ok: true, why: `対角線 ${diag.names.join('')}、隠れ頂点 ${b.hidden}` };
    },
  },
  {
    id: 'parabola',
    tag: '関数・面積',
    prompt: '放物線 y = x^2 と直線 y = x で囲まれた部分を図示して。',
    check(r) {
      const cs = Object.values(r.curves);
      if (cs.length < 2) return { ok: false, why: `曲線が ${cs.length} 本しかない` };
      const fill = r.draws.find((d) => d.t === 'poly' && d.fill);
      if (!fill) return { ok: false, why: '囲まれた部分が塗られていない' };
      // 塗られた領域が (0,0)-(1,1) に収まり、面積が 1/6 に近いか
      const xs = fill.ps.map((p) => p.x), ys = fill.ps.map((p) => p.y);
      let area = 0;
      for (let i = 0; i < fill.ps.length; i++) {
        const p = fill.ps[i], q = fill.ps[(i + 1) % fill.ps.length];
        area += p.x * q.y - q.x * p.y;
      }
      area = Math.abs(area) / 2;
      const box = Math.min(...xs) > -0.01 && Math.max(...xs) < 1.01 && Math.min(...ys) > -0.01 && Math.max(...ys) < 1.01;
      if (!box) return { ok: false, why: `塗った範囲が [0,1]² を外れている (x:${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)})` };
      return Math.abs(area - 1 / 6) < 0.005
        ? { ok: true, why: `面積 ${area.toFixed(4)}(1/6 = 0.1667)` }
        : { ok: false, why: `面積 ${area.toFixed(4)}(1/6 のはず)` };
    },
  },
  {
    id: 'cycloid',
    tag: '媒介変数',
    prompt: '半径1の円がx軸上をすべらずに1回転するとき、円周上の定点が描く曲線(サイクロイド)を図示して。',
    check(r) {
      const cv = r.draws.find((d) => d.t === 'curve');
      if (!cv) return { ok: false, why: '曲線が無い' };
      const ps = cv.ps, s = ps[0], e = ps[ps.length - 1];
      const top = Math.max(...ps.map((p) => p.y));
      const bad = [];
      if (dist(s, { x: 0, y: 0 }) > 0.05) bad.push(`始点 (${s.x.toFixed(2)},${s.y.toFixed(2)})`);
      if (dist(e, { x: 2 * Math.PI, y: 0 }) > 0.05) bad.push(`終点 (${e.x.toFixed(2)},${e.y.toFixed(2)})`);
      if (Math.abs(top - 2) > 0.02) bad.push(`最高点 y=${top.toFixed(3)}`);
      return bad.length
        ? { ok: false, why: bad.join(' / ') + ' が合わない' }
        : { ok: true, why: `(0,0)→(2π,0)、最高点 y=${top.toFixed(3)}` };
    },
  },
  {
    id: 'revolve',
    tag: '回転体',
    prompt: '曲線 y = sqrt(x) (0 ≦ x ≦ 4) をx軸のまわりに1回転してできる立体を図示して。',
    check(r) {
      const top = r.draws.find((d) => d.revolveTop);
      if (!top) return { ok: false, why: '回転体になっていない(revolve を使っていない)' };
      const bot = r.draws.find((d) => d.revolveBottom);
      const caps = r.draws.filter((d) => d.cap);
      const t = top.ps, lo = t[0], hi = t[t.length - 1];
      const bad = [];
      if (Math.abs(lo.x) > 0.02 || Math.abs(lo.y) > 0.02) bad.push(`左端 (${lo.x.toFixed(2)},${lo.y.toFixed(2)})`);
      if (Math.abs(hi.x - 4) > 0.02 || Math.abs(hi.y - 2) > 0.02) bad.push(`右端 (${hi.x.toFixed(2)},${hi.y.toFixed(2)})`);
      if (!bot) bad.push('下半分が無い');
      if (!caps.length) bad.push('切り口が無い');
      else if (Math.abs(caps[caps.length - 1].ry - 2) > 0.02) bad.push(`切り口の半径 ${caps[caps.length - 1].ry.toFixed(2)}(2 のはず)`);
      return bad.length ? { ok: false, why: bad.join(' / ') } : { ok: true, why: `(0,0)→(4,2)、上下対称、切り口 r=2` };
    },
  },
];
