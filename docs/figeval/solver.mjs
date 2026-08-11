// docs/wireframe_board_v2.html の solve() をそのまま取り出したもの。
// ちがうのは 2 点だけ:
//   1. 曲線の式は JSON なので **文字列**。ここで関数に直す(実装では plot_expression.dart)
//   2. 描画(SVG)は落とし、解けた座標だけを返す
// 判定を甘くしないために、解けなかったものは例外を投げる。

const ALLOWED = /^[0-9xyt+\-*/^().,\s a-z]*$/;
const FNS = ['sin', 'cos', 'tan', 'sqrt', 'abs', 'exp', 'log', 'pow', 'pi', 'x', 'y', 't', 'e'];

// 式の文字列 → 関数。**知らない名前が出たら失敗させる**(黙って NaN にしない)。
export function compile(src, varName) {
  if (typeof src === 'function') return src;
  if (typeof src !== 'string') throw new Error('式が文字列ではない: ' + JSON.stringify(src));
  const s = src.replace(/\^/g, '**');
  if (!ALLOWED.test(s)) throw new Error('使えない文字がある式: ' + src);
  for (const w of s.match(/[a-z]+/g) || []) {
    if (!FNS.includes(w)) throw new Error('知らない名前: ' + w + ' (式: ' + src + ')');
  }
  const body = 'with(Math){const pi=PI;return (' + s + ');}';
  // eslint-disable-next-line no-new-func
  const f = new Function(varName, body);
  return (v) => f(v);
}

// 解いた座標を人に見せる形にする。-0 や 2.0000000001 を出さない。
const fmt = (v) => {
  const r = Math.abs(v) < 1e-9 ? 0 : v;
  return Math.abs(r - Math.round(r)) < 1e-9 ? String(Math.round(r)) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

export function solve(items) {
  const pts = {}, circles = {}, lines = {}, curves = {}, draws = [];
  let states = [];
  const P = (n) => {
    if (!pts[n]) throw new Error('未定義の点: ' + n);
    return pts[n];
  };
  const L = (spec) => {
    if (typeof spec === 'string') {
      if (!lines[spec]) throw new Error('未定義の直線: ' + spec);
      return lines[spec];
    }
    return { a: P(spec[0]), b: P(spec[1]) };
  };

  function definePoint(it) {
    if (it.pts && it.meetCircles) {
      const both = meetCircles(circles[it.meetCircles[0]], circles[it.meetCircles[1]]);
      if (!both) throw new Error('2円が交わらない: ' + it.meetCircles);
      it.pts.forEach((nm, i) => { pts[nm] = both[i]; draws.push({ t: 'pt', p: both[i], name: nm }); });
      return;
    }
    let p;
    if (it.at) p = { x: it.at[0], y: it.at[1] };
    else if (it.onCircle && it.byLine) p = secondMeet(circles[it.onCircle], L(it.byLine), it.other ? P(it.other) : null);
    else if (it.along) { const ln = L(it.along); p = { x: ln.a.x + (ln.b.x - ln.a.x) * it.k, y: ln.a.y + (ln.b.y - ln.a.y) * it.k }; }
    else if (it.on && it.ratio) {
      const s = P(it.on[0]), e = P(it.on[1]), k = it.ratio[0] / (it.ratio[0] + it.ratio[1]);
      p = { x: s.x + (e.x - s.x) * k, y: s.y + (e.y - s.y) * k };
    } else if (it.on) {
      const kc = circles[it.on];
      if (!kc) throw new Error('未定義の円: ' + it.on);
      const a = it.deg * Math.PI / 180;
      p = { x: kc.c.x + kc.r * Math.cos(a), y: kc.c.y + kc.r * Math.sin(a) };
    } else if (it.mid) { const u = P(it.mid[0]), v = P(it.mid[1]); p = { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 }; }
    else if (it.centroid) { const g = it.centroid.map(P); p = { x: (g[0].x + g[1].x + g[2].x) / 3, y: (g[0].y + g[1].y + g[2].y) / 3 }; }
    else if (it.meetCurves) {
      const ca = curves[it.meetCurves[0]], cb = curves[it.meetCurves[1]];
      if (!ca || !cb) throw new Error('未定義の曲線: ' + it.meetCurves);
      const xr = crossing(ca, cb, it.near ?? 0);
      if (xr === null) throw new Error('2曲線が交わらない: ' + it.meetCurves);
      p = { x: xr, y: ca.py(xr) };
    } else if (it.meet) p = meet(L(it.meet[0]), L(it.meet[1]));
    if (!p) throw new Error('点を決められない: ' + JSON.stringify(it));
    if (!isFinite(p.x) || !isFinite(p.y)) throw new Error('座標が数でない: ' + it.pt);
    pts[it.pt] = p;
    // **座標は解いた値をこちらが出す。**書く側に数字を書かせない(食い違いようがなくなる)
    const coord = it.showCoord ? `(${fmt(p.x)}, ${fmt(p.y)})` : undefined;
    if (!it.hide) draws.push({ t: 'pt', p, name: it.pt, coord });
  }

  function defineBox(it) {
    const [w, h, d] = it.size;
    const v3 = [[0, h, d], [0, h, 0], [w, h, 0], [w, h, d], [0, 0, d], [0, 0, 0], [w, 0, 0], [w, 0, d]];
    const pv = v3.map(project);
    const hull = convexHull(pv);
    let hidden = -1, far = -Infinity;
    pv.forEach((p, i) => {
      if (hull.indexOf(p) >= 0) return;
      if (v3[i][2] > far) { far = v3[i][2]; hidden = i; }
    });
    it.labels.forEach((nm, i) => { pts[nm] = pv[i]; draws.push({ t: 'pt', p: pv[i], name: nm, small: true }); });
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    edges.forEach((e) => draws.push({ t: 'seg', a: pv[e[0]], b: pv[e[1]], dash: e[0] === hidden || e[1] === hidden }));
    draws.push({ t: 'box3', hidden: it.labels[hidden], labels: it.labels, size: it.size, v3 });
  }

  for (const it of items) {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) throw new Error('要素がオブジェクトでない: ' + JSON.stringify(it));
    // **すでに定義した点を、あとから目立たせる。**
    // これが無いせいで、モデルは `{"pt":"L"}`(位置なし)を書いて落ちていた。
    // モデルの間違いではなく、語彙の穴だったので塞ぐ。
    if (it.mark) {
      const names = Array.isArray(it.mark) ? it.mark : [it.mark];
      names.forEach((n) => draws.push({ t: 'mark', p: P(n), name: n, as: it.as }));
    } else if (it.pt || it.pts) definePoint(it);
    else if (it.box3) defineBox(it);
    else if (it.circle) {
      const c = P(it.center);
      circles[it.circle] = { c, r: it.r };
      draws.push({ t: 'circle', c, r: it.r, name: it.circle });
    } else if (it.line) {
      const base = L(it.perp), q = P(it.through);
      const dx = base.b.x - base.a.x, dy = base.b.y - base.a.y;
      lines[it.line] = { a: q, b: { x: q.x - dy, y: q.y + dx } };
    } else if (it.seg) draws.push({ t: 'seg', a: P(it.seg[0]), b: P(it.seg[1]), names: it.seg, dash: !!it.dash, label: it.label, as: it.as });
    else if (it.poly) draws.push({ t: 'poly', ps: it.poly.map(P), names: it.poly, fill: !!it.fill, as: it.as });
    else if (it.ellipse) draws.push({ t: 'ellipse', c: P(it.center), rx: it.rx, ry: it.ry, as: it.as, dash: !!it.dash });
    // **キーの有無で枝を選ぶと、`{"axes":0}` のような「偽になる正しい値」を取りこぼす。**
    // 実際 Sonnet は「軸は要らない」を `{"axes":0}` と書いてきて、
    // こちらは「知らないキー」と言って落ちた。**モデルのせいにしていたが、こちらのバグ。**
    // 本番の契約(board.ts)が `kind` の discriminated union なのは、まさにこれを避けるため。
    else if (it.axes !== undefined) {
      if (it.axes === 0 || it.axes === false) continue;        // 「軸は要らない」
      draws.push({ t: 'axes', span: typeof it.axes === 'number' ? [-it.axes, it.axes, -it.axes, it.axes] : it.axes, ticks: it.ticks });
    }
    else if (it.signTable) {
      // 増減表。**渡ってくるのは極値の x だけ。**
      // 符号も値も矢印も曲線から出すので、three つが食い違うことがない。
      const cv = curves[it.signTable];
      if (!cv) throw new Error('未定義の曲線の増減表: ' + it.signTable);
      if (!cv.f) throw new Error('y=f(x) の形でない曲線の増減表: ' + it.signTable);
      const crit = (it.crit || []).slice().sort((a, b) => a - b);
      const [lo, hi] = cv.domain;
      for (const c of crit) if (c <= lo || c >= hi) throw new Error(`極値 ${c} が定義域 [${lo},${hi}] の外`);
      const d1 = (x) => { const h = 1e-5; return (cv.f(x + h) - cv.f(x - h)) / (2 * h); };
      const cuts = [lo, ...crit, hi];
      const sign = [];                       // 区間ごとの f' の符号
      for (let i = 0; i < cuts.length - 1; i++) {
        const m = (cuts[i] + cuts[i + 1]) / 2, s = d1(m);
        sign.push(s > 1e-6 ? '+' : s < -1e-6 ? '-' : '0');
      }
      draws.push({
        t: 'signTable', curve: it.signTable, crit,
        sign,                                                    // 区間の符号
        arrow: sign.map((s) => (s === '+' ? '↗' : s === '-' ? '↘' : '→')),
        values: crit.map((c) => ({ x: c, y: cv.f(c), d: d1(c) })),
      });
    } else if (it.states) {
      // 状態は名前だけ受け取り、**並べるのはこちら**(円形に置く)
      const n = it.states.length;
      if (n < 2) throw new Error('状態が2つ未満');
      states = it.states.map((nm, i) => {
        const a = Math.PI / 2 + (2 * Math.PI * i) / n;
        const p = { x: 3 * Math.cos(a), y: 3 * Math.sin(a) };
        pts[nm] = p;
        return { name: nm, p };
      });
      draws.push({ t: 'states', states });
    } else if (it.edges) {
      if (!states.length) throw new Error('states より先に edges が来た');
      const known = new Set(states.map((s) => s.name));
      const es = it.edges.map(([from, to, prob]) => {
        if (!known.has(from)) throw new Error('知らない状態: ' + from);
        if (!known.has(to)) throw new Error('知らない状態: ' + to);
        const v = compile(String(prob), '_')(0);
        if (!isFinite(v)) throw new Error('確率が数でない: ' + prob);
        return { from, to, prob: String(prob), value: v, self: from === to };
      });
      draws.push({ t: 'edges', edges: es });
    } else if (it.seats) {
      // 円順列。**席の位置はこちらが等間隔に置く。**
      const n = it.seats, labels = it.labels || [];
      if (labels.length && labels.length !== n) throw new Error(`席 ${n} に対して名前が ${labels.length} 個`);
      if (it.fix && !labels.includes(it.fix)) throw new Error('固定する人が名前の中にいない: ' + it.fix);
      const seats = Array.from({ length: n }, (_, i) => {
        const a = Math.PI / 2 - (2 * Math.PI * i) / n;      // 時計回り。上から始める
        return { name: labels[i], p: { x: 3 * Math.cos(a), y: 3 * Math.sin(a) }, fixed: labels[i] === it.fix };
      });
      seats.forEach((s) => { if (s.name) pts[s.name] = s.p; });
      draws.push({ t: 'seats', seats, n, fix: it.fix });
    } else if (it.balls) {
      // 玉。**個数だけ受け取り、並べるのはこちら。**
      const kinds = Object.entries(it.balls);
      if (!kinds.length) throw new Error('玉が0種類');
      const list = [];
      kinds.forEach(([kind, count], ki) => {
        if (!Number.isInteger(count) || count < 0) throw new Error(`${kind} の個数が整数でない: ${count}`);
        for (let i = 0; i < count; i++) list.push({ kind, ki });
      });
      const cols = Math.ceil(Math.sqrt(list.length)) || 1;
      list.forEach((b, i) => { b.p = { x: (i % cols) - (cols - 1) / 2, y: -Math.floor(i / cols) }; });
      draws.push({ t: 'balls', balls: list, kinds: Object.fromEntries(kinds), container: it.container });
    } else if (it.dice) {
      // サイコロ。**目の数だけ受け取る。点の並びは目で決まっているので、こちらが置く。**
      const PIPS = {
        1: [[0, 0]], 2: [[-1, 1], [1, -1]], 3: [[-1, 1], [0, 0], [1, -1]],
        4: [[-1, 1], [1, 1], [-1, -1], [1, -1]],
        5: [[-1, 1], [1, 1], [0, 0], [-1, -1], [1, -1]],
        6: [[-1, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]],
      };
      const faces = it.dice.map((v) => {
        if (!PIPS[v]) throw new Error('サイコロの目が 1〜6 でない: ' + v);
        return { value: v, pips: PIPS[v] };
      });
      draws.push({ t: 'dice', faces });
    } else if (it.diceTable) {
      const cells = [];
      for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) {
        const mark = it.markSum !== undefined ? a + b === it.markSum
          : it.markDiff !== undefined ? Math.abs(a - b) === it.markDiff : false;
        cells.push({ a, b, mark });
      }
      draws.push({ t: 'diceTable', cells, marked: cells.filter((c) => c.mark).length, markSum: it.markSum });
    }
    else if (it.curve) {
      curves[it.curve] = normalizeCurve(it);
      if (!it.hidden) draws.push({ t: 'curve', name: it.curve, ps: sample(curves[it.curve]), as: it.as, dash: !!it.dash });
    } else if (it.revolve) {
      const cv = curves[it.revolve];
      if (!cv) throw new Error('未定義の曲線を回そうとした: ' + it.revolve);
      const k = 0.26;
      const ax = it.around && it.around.x !== undefined ? it.around : { y: (it.around || {}).y || 0 };
      const base = sample(cv, it.range);
      draws.push({ t: 'curve', ps: base, as: it.as, revolveTop: true });
      draws.push({ t: 'curve', ps: base.map((p) => mirrorAbout(p, ax)), as: it.as, revolveBottom: true });
      const xs0 = base.map((p) => p.x), ys0 = base.map((p) => p.y);
      if (ax.x !== undefined) draws.push({ t: 'seg', a: { x: ax.x, y: Math.min(...ys0) }, b: { x: ax.x, y: Math.max(...ys0) }, as: 'aux', axis: true });
      else draws.push({ t: 'seg', a: { x: Math.min(...xs0), y: ax.y }, b: { x: Math.max(...xs0), y: ax.y }, as: 'aux', axis: true });
      [base[0], base[base.length - 1]].forEach((p, i) => {
        const r = radiusTo(p, ax);
        if (r < 1e-6) return;
        const c0 = ax.x !== undefined ? { x: ax.x, y: p.y } : { x: p.x, y: ax.y };
        draws.push({ t: 'ellipse', c: c0, rx: ax.x !== undefined ? r : r * k, ry: ax.x !== undefined ? r * k : r, as: i === 1 ? it.capAs : undefined, cap: true });
      });
    } else if (it.fillUnder) {
      const cu = sample(curves[it.fillUnder], it.range);
      draws.push({ t: 'poly', fill: true, as: it.as, ps: [{ x: cu[0].x, y: 0 }, ...cu, { x: cu[cu.length - 1].x, y: 0 }] });
    } else if (it.fillBetween) {
      const c1 = curves[it.fillBetween[0]], c2 = curves[it.fillBetween[1]];
      if (!c1 || !c2) throw new Error('未定義の曲線を塗ろうとした: ' + it.fillBetween);
      const x0 = P(it.from).x, x1 = P(it.to).x;
      const up = sample(c1, [x0, x1]), down = sample(c2, [x0, x1]).reverse();
      draws.push({ t: 'poly', ps: up.concat(down), fill: true, as: it.as, open: true });
    } else if (it.arc) draws.push({ t: 'arc', a: P(it.arc[0]), o: P(it.arc[1]), b: P(it.arc[2]), names: it.arc, label: it.label });
    else if (it.right) draws.push({ t: 'right', a: P(it.right[0]), o: P(it.right[1]), b: P(it.right[2]), names: it.right });
    else throw new Error('知らないキー: ' + JSON.stringify(Object.keys(it)));
  }
  return { draws, pts, circles, curves, lines };
}

function normalizeCurve(it) {
  if (it.px) return { px: compile(it.px, 't'), py: compile(it.py, 't'), domain: it.domain, param: true };
  if (it.of === 'y') { const g = compile(it.f, 'y'); return { px: g, py: (t) => t, domain: it.domain, g }; }
  const f = compile(it.f, 'x');
  return { px: (t) => t, py: f, domain: it.domain, f };
}

function sample(cv, range) {
  const d = range || cv.domain;
  if (!d) throw new Error('domain が無い曲線');
  const out = [];
  for (let i = 0; i <= 120; i++) {
    const t = d[0] + (d[1] - d[0]) * i / 120, x = cv.px(t), y = cv.py(t);
    if (isFinite(x) && isFinite(y)) out.push({ x, y });
  }
  if (!out.length) throw new Error('曲線が1点も引けない');
  return out;
}

const mirrorAbout = (p, ax) => (ax.x !== undefined ? { x: 2 * ax.x - p.x, y: p.y } : { x: p.x, y: 2 * ax.y - p.y });
const radiusTo = (p, ax) => (ax.x !== undefined ? Math.abs(p.x - ax.x) : Math.abs(p.y - ax.y));

function crossing(ca, cb, near) {
  const lo = Math.max(ca.domain[0], cb.domain[0]), hi = Math.min(ca.domain[1], cb.domain[1]);
  const h = (x) => ca.py(x) - cb.py(x);
  let best = null, prev = h(lo), px = lo;
  for (let i = 1; i <= 400; i++) {
    const x = lo + (hi - lo) * i / 400, cur = h(x);
    if (isFinite(prev) && isFinite(cur) && prev * cur <= 0) {
      let a = px, b = x;
      for (let k = 0; k < 60; k++) { const m = (a + b) / 2; if (h(a) * h(m) <= 0) b = m; else a = m; }
      const r = (a + b) / 2;
      if (best === null || Math.abs(r - near) < Math.abs(best - near)) best = r;
    }
    prev = cur; px = x;
  }
  return best;
}

function project(p) {
  const k = 0.56, a = 40 * Math.PI / 180;
  return { x: p[0] + p[2] * k * Math.cos(a), y: p[1] + p[2] * k * Math.sin(a) };
}

function convexHull(ps) {
  const s = ps.slice().sort((u, v) => u.x - v.x || u.y - v.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list) => {
    const out = [];
    list.forEach((p) => {
      while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    });
    out.pop();
    return out;
  };
  return half(s).concat(half(s.slice().reverse()));
}

function meet(l1, l2) {
  const a = l1.a, x1 = l1.b.x - a.x, y1 = l1.b.y - a.y;
  const c = l2.a, x2 = l2.b.x - c.x, y2 = l2.b.y - c.y;
  const den = x1 * y2 - y1 * x2;
  if (Math.abs(den) < 1e-9) throw new Error('平行な2直線の交点を取ろうとした');
  const t = ((c.x - a.x) * y2 - (c.y - a.y) * x2) / den;
  return { x: a.x + t * x1, y: a.y + t * y1 };
}

function meetCircles(k1, k2) {
  if (!k1 || !k2) throw new Error('未定義の円');
  const dx = k2.c.x - k1.c.x, dy = k2.c.y - k1.c.y, d = Math.hypot(dx, dy);
  if (d > k1.r + k2.r || d < Math.abs(k1.r - k2.r) || d === 0) return null;
  const a = (k1.r * k1.r - k2.r * k2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(k1.r * k1.r - a * a, 0));
  const mx = k1.c.x + a * dx / d, my = k1.c.y + a * dy / d;
  return [{ x: mx - h * dy / d, y: my + h * dx / d }, { x: mx + h * dy / d, y: my - h * dx / d }];
}

function secondMeet(k, line, other) {
  if (!k) throw new Error('未定義の円');
  let ux = line.b.x - line.a.x, uy = line.b.y - line.a.y;
  const n = Math.hypot(ux, uy); ux /= n; uy /= n;
  const wx = line.a.x - k.c.x, wy = line.a.y - k.c.y;
  const b = ux * wx + uy * wy, cc = wx * wx + wy * wy - k.r * k.r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const cands = [-b + s, -b - s].map((t) => ({ x: line.a.x + t * ux, y: line.a.y + t * uy }));
  if (!other) return cands[0];
  return Math.hypot(cands[0].x - other.x, cands[0].y - other.y) > Math.hypot(cands[1].x - other.x, cands[1].y - other.y) ? cands[0] : cands[1];
}
