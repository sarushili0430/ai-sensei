// docs/wireframe_board_v2.html の solve() をそのまま取り出したもの。
// ちがうのは 2 点だけ:
//   1. 曲線の式は JSON なので **文字列**。ここで関数に直す(実装では plot_expression.dart)
//   2. 描画(SVG)は落とし、解けた座標だけを返す
// 判定を甘くしないために、解けなかったものは例外を投げる。

const ALLOWED = /^[0-9xyt+\-*/^().,\s a-z]*$/;
const FNS = ["sin", "cos", "tan", "sqrt", "abs", "exp", "log", "pow", "pi", "x", "y", "t", "e"];

// 式の文字列 → 関数。**知らない名前が出たら失敗させる**(黙って NaN にしない)。
export function compile(src, varName) {
  if (typeof src === "function") return src;
  if (typeof src !== "string") throw new Error(`式が文字列ではない: ${JSON.stringify(src)}`);
  const s = src.replace(/\^/g, "**");
  if (!ALLOWED.test(s)) throw new Error(`使えない文字がある式: ${src}`);
  for (const w of s.match(/[a-z]+/g) || []) {
    if (!FNS.includes(w)) throw new Error(`知らない名前: ${w} (式: ${src})`);
  }
  const body = `with(Math){const pi=PI;return (${s});}`;
  // eslint-disable-next-line no-new-func
  const f = new Function(varName, body);
  return (v) => f(v);
}

// 解いた座標を人に見せる形にする。-0 や 2.0000000001 を出さない。
const fmt = (v) => {
  const r = Math.abs(v) < 1e-9 ? 0 : v;
  return Math.abs(r - Math.round(r)) < 1e-9
    ? String(Math.round(r))
    : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

// 2変数の式 f(x,y)。領域の判定に使う。
export function compile2(src) {
  if (typeof src !== "string") throw new Error(`式が文字列ではない: ${JSON.stringify(src)}`);
  const s = src.replace(/\^/g, "**");
  if (!ALLOWED.test(s)) throw new Error(`使えない文字がある式: ${src}`);
  for (const w of s.match(/[a-z]+/g) || []) {
    if (!FNS.includes(w)) throw new Error(`知らない名前: ${w} (式: ${src})`);
  }
  // eslint-disable-next-line no-new-func
  const f = new Function("x", "y", `with(Math){const pi=PI;return (${s});}`);
  return (x, y) => f(x, y);
}

// 五数要約。**データから計算する。**モデルに書かせない。
function fiveNumber(data) {
  const a = data.slice().sort((p, q) => p - q);
  const n = a.length;
  const q = (p) => {
    // 高校の四分位数(中央値で二分し、各半分の中央値)
    const k = (n - 1) * p;
    const lo = Math.floor(k);
    const hi = Math.ceil(k);
    return a[lo] + (a[hi] - a[lo]) * (k - lo);
  };
  return { min: a[0], q1: q(0.25), med: q(0.5), q3: q(0.75), max: a[n - 1] };
}

// 標準正規分布の累積。斜線部の面積を出すのに使う(Abramowitz-Stegun 26.2.17)。
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export function solve(items) {
  const pts = {};
  const circles = {};
  const lines = {};
  const curves = {};
  const draws = [];
  let states = [];
  const P = (n) => {
    if (!pts[n]) throw new Error(`未定義の点: ${n}`);
    return pts[n];
  };
  const L = (spec) => {
    if (typeof spec === "string") {
      if (!lines[spec]) throw new Error(`未定義の直線: ${spec}`);
      return lines[spec];
    }
    return { a: P(spec[0]), b: P(spec[1]) };
  };

  function definePoint(it) {
    if (it.pts && it.meetCircles) {
      const both = meetCircles(circles[it.meetCircles[0]], circles[it.meetCircles[1]]);
      if (!both) throw new Error(`2円が交わらない: ${it.meetCircles}`);
      it.pts.forEach((nm, i) => {
        pts[nm] = both[i];
        draws.push({ t: "pt", p: both[i], name: nm });
      });
      return;
    }
    let p;
    // **「A から距離4、向き-30°」。**これが無いせいで、モデルは点を手で置いて
    // 辺に "4" と書くしかなくなり、**実際の長さと合わないラベル**が出ていた
    // (AB=6 と書いた辺より AC=4 と書いた辺のほうが長い図が出た)。
    // 長さが決まっている図形は、長さで置かせる。
    if (it.from && it.dist !== undefined) {
      const o = P(it.from);
      const a = ((it.deg ?? 0) * Math.PI) / 180;
      if (!(it.dist > 0)) throw new Error(`距離が正でない: ${it.dist}`);
      p = { x: o.x + it.dist * Math.cos(a), y: o.y + it.dist * Math.sin(a) };
    } else if (it.at) p = { x: it.at[0], y: it.at[1] };
    else if (it.onCircle && it.byLine)
      p = secondMeet(circles[it.onCircle], L(it.byLine), it.other ? P(it.other) : null);
    else if (it.along) {
      const ln = L(it.along);
      p = { x: ln.a.x + (ln.b.x - ln.a.x) * it.k, y: ln.a.y + (ln.b.y - ln.a.y) * it.k };
    } else if (it.on && it.ratio) {
      const s = P(it.on[0]);
      const e = P(it.on[1]);
      const k = it.ratio[0] / (it.ratio[0] + it.ratio[1]);
      p = { x: s.x + (e.x - s.x) * k, y: s.y + (e.y - s.y) * k };
    } else if (it.onCurve !== undefined) {
      // 曲線上の点。媒介変数(y=f(x) なら x)の値で指す。
      const cv = curves[it.onCurve];
      if (!cv)
        throw new Error(
          `未定義の曲線: ${it.onCurve}(ある曲線: ${Object.keys(curves).join(",") || "なし"})`,
        );
      const t = it.t ?? (Array.isArray(it.at) ? it.at[0] : it.at);
      if (typeof t !== "number") throw new Error("曲線上の点は t に媒介変数の値を書く");
      p = { x: cv.px(t), y: cv.py(t) };
    } else if (it.on) {
      const kc = circles[it.on];
      if (!kc) {
        // **円と曲線で名前空間が同じなので、取り違えるとここへ来る。**
        // どちらがあるかを出して、書き直せるようにする(黙って落とさない)。
        const hint = curves[it.on]
          ? `— ${it.on} は曲線です。曲線上の点は {"pt":..,"onCurve":"${it.on}","t":..} で指します`
          : `(いまある円: ${Object.keys(circles).join(", ") || "なし"})`;
        throw new Error(`未定義の円: ${it.on} ${hint}`);
      }
      const a = (it.deg * Math.PI) / 180;
      p = { x: kc.c.x + kc.r * Math.cos(a), y: kc.c.y + kc.r * Math.sin(a) };
    } else if (it.mid) {
      const u = P(it.mid[0]);
      const v = P(it.mid[1]);
      p = { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 };
    } else if (it.centroid) {
      const g = it.centroid.map(P);
      p = { x: (g[0].x + g[1].x + g[2].x) / 3, y: (g[0].y + g[1].y + g[2].y) / 3 };
    } else if (it.meetCurves) {
      const ca = curves[it.meetCurves[0]];
      const cb = curves[it.meetCurves[1]];
      if (!ca || !cb) throw new Error(`未定義の曲線: ${it.meetCurves}`);
      const xr = crossing(ca, cb, it.near ?? 0);
      if (xr === null) throw new Error(`2曲線が交わらない: ${it.meetCurves}`);
      p = { x: xr, y: ca.py(xr) };
    } else if (it.meet) p = meet(L(it.meet[0]), L(it.meet[1]));
    if (!p) throw new Error(`点を決められない: ${JSON.stringify(it)}`);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`座標が数でない: ${it.pt}`);
    pts[it.pt] = p;
    // **座標は解いた値をこちらが出す。**書く側に数字を書かせない(食い違いようがなくなる)
    const coord = it.showCoord ? `(${fmt(p.x)}, ${fmt(p.y)})` : undefined;
    if (!it.hide) draws.push({ t: "pt", p, name: it.pt, coord });
  }

  function defineBox(it) {
    const [w, h, d] = it.size;
    const v3 = [
      [0, h, d],
      [0, h, 0],
      [w, h, 0],
      [w, h, d],
      [0, 0, d],
      [0, 0, 0],
      [w, 0, 0],
      [w, 0, d],
    ];
    const pv = v3.map(project);
    const hull = convexHull(pv);
    let hidden = -1;
    let far = Number.NEGATIVE_INFINITY;
    pv.forEach((p, i) => {
      if (hull.indexOf(p) >= 0) return;
      if (v3[i][2] > far) {
        far = v3[i][2];
        hidden = i;
      }
    });
    it.labels.forEach((nm, i) => {
      pts[nm] = pv[i];
      draws.push({ t: "pt", p: pv[i], name: nm, small: true });
    });
    const edges = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];
    edges.forEach((e) =>
      draws.push({ t: "seg", a: pv[e[0]], b: pv[e[1]], dash: e[0] === hidden || e[1] === hidden }),
    );
    draws.push({ t: "box3", hidden: it.labels[hidden], labels: it.labels, size: it.size, v3 });
  }

  for (const it of items) {
    if (it === null || typeof it !== "object" || Array.isArray(it))
      throw new Error(`要素がオブジェクトでない: ${JSON.stringify(it)}`);
    // **すでに定義した点を、あとから目立たせる。**
    // これが無いせいで、モデルは `{"pt":"L"}`(位置なし)を書いて落ちていた。
    // モデルの間違いではなく、語彙の穴だったので塞ぐ。
    if (it.mark) {
      const names = Array.isArray(it.mark) ? it.mark : [it.mark];
      names.forEach((n) => draws.push({ t: "mark", p: P(n), name: n, as: it.as }));
    } else if (it.pt || it.pts) definePoint(it);
    else if (it.box3) defineBox(it);
    else if (it.circle) {
      const c = P(it.center);
      circles[it.circle] = { c, r: it.r };
      draws.push({ t: "circle", c, r: it.r, name: it.circle });
    } else if (it.line) {
      if (it.bisect) {
        // 角の二等分線。頂点は真ん中。**2辺の単位ベクトルの和が向き**(長さに寄らない)
        const [a, o, b] = it.bisect.map(P);
        const u = norm(a, o);
        const v = norm(b, o);
        lines[it.line] = { a: o, b: { x: o.x + u.x + v.x, y: o.y + u.y + v.y } };
      } else if (it.perpBisect) {
        // 垂直二等分線。中点を通り、その線分に垂直
        const [a, b] = it.perpBisect.map(P);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        lines[it.line] = { a: m, b: { x: m.x - (b.y - a.y), y: m.y + (b.x - a.x) } };
      } else if (it.perp) {
        const base = L(it.perp);
        const q = P(it.through);
        const dx = base.b.x - base.a.x;
        const dy = base.b.y - base.a.y;
        lines[it.line] = { a: q, b: { x: q.x - dy, y: q.y + dx } };
      } else if (it.parallel) {
        const base = L(it.parallel);
        const q = P(it.through);
        lines[it.line] = {
          a: q,
          b: { x: q.x + base.b.x - base.a.x, y: q.y + base.b.y - base.a.y },
        };
      } else throw new Error(`直線の作り方が指定されていない: ${it.line}`);
    } else if (it.seg) {
      const sa = P(it.seg[0]);
      const sb = P(it.seg[1]);
      const len = Math.hypot(sa.x - sb.x, sa.y - sb.y);
      // **数字のラベルは、実際の長さと合っていなければ通さない。**
      // 合わないと「絵は自然、中身は嘘」になる(AB=6 と書いた辺より
      // AC=4 と書いた辺のほうが長い図が、実際に出た)。
      // **長さとみなすのは「数字だけ(単位つき可)」のラベルに限る。**
      // 最初これを「数字以外を捨てて数にする」で書いたら、`"x+y=4"` を 4、
      // `"y = 1/2"` を 12 と読んで、**式のラベルを長さ違いとして落としていた。**
      // 検算は、確実に長さを指しているときだけ効かせる。
      const m =
        typeof it.label === "string"
          ? it.label.trim().match(/^(\d+(?:\.\d+)?)\s*(cm|mm|m|km)?$/)
          : null;
      const num = m ? Number(m[1]) : Number.NaN;
      if (Number.isFinite(num) && num > 0 && Math.abs(len - num) / num > 0.02) {
        throw new Error(
          `${it.seg.join("")} のラベル "${it.label}" と実際の長さ ${len.toFixed(2)} が合わない`,
        );
      }
      draws.push({
        t: "seg",
        a: sa,
        b: sb,
        names: it.seg,
        dash: !!it.dash,
        as: it.as,
        label: it.showLength ? fmt(len) : it.label, // showLength ならこちらが書く
        length: len,
        part: it.part,
      });
    } else if (it.poly)
      draws.push({ t: "poly", ps: it.poly.map(P), names: it.poly, fill: !!it.fill, as: it.as });
    else if (it.ellipse)
      draws.push({
        t: "ellipse",
        c: P(it.center),
        rx: it.rx,
        ry: it.ry,
        as: it.as,
        dash: !!it.dash,
      });
    // **キーの有無で枝を選ぶと、`{"axes":0}` のような「偽になる正しい値」を取りこぼす。**
    // 実際 Sonnet は「軸は要らない」を `{"axes":0}` と書いてきて、
    // こちらは「知らないキー」と言って落ちた。**モデルのせいにしていたが、こちらのバグ。**
    // 本番の契約(board.ts)が `kind` の discriminated union なのは、まさにこれを避けるため。
    else if (it.axes !== undefined) {
      if (it.axes === 0 || it.axes === false) continue; // 「軸は要らない」
      // 原点を置く。**軸を描いたら O は在る**のが自然で、
      // 無いせいで「O から線を引く」が両モデルとも落ちていた。
      pts.O = pts.O ?? { x: 0, y: 0 };
      draws.push({
        t: "axes",
        span: typeof it.axes === "number" ? [-it.axes, it.axes, -it.axes, it.axes] : it.axes,
        ticks: it.ticks,
      });
    } else if (it.signTable) {
      // 増減表。**渡ってくるのは極値の x だけ。**
      // 符号も値も矢印も曲線から出すので、three つが食い違うことがない。
      const cv = curves[it.signTable];
      if (!cv) throw new Error(`未定義の曲線の増減表: ${it.signTable}`);
      if (!cv.f) throw new Error(`y=f(x) の形でない曲線の増減表: ${it.signTable}`);
      const crit = (it.crit || []).slice().sort((a, b) => a - b);
      const [lo, hi] = cv.domain;
      for (const c of crit)
        if (c <= lo || c >= hi) throw new Error(`極値 ${c} が定義域 [${lo},${hi}] の外`);
      const d1 = (x) => {
        const h = 1e-5;
        return (cv.f(x + h) - cv.f(x - h)) / (2 * h);
      };
      const cuts = [lo, ...crit, hi];
      const sign = []; // 区間ごとの f' の符号
      for (let i = 0; i < cuts.length - 1; i++) {
        const m = (cuts[i] + cuts[i + 1]) / 2;
        const s = d1(m);
        sign.push(s > 1e-6 ? "+" : s < -1e-6 ? "-" : "0");
      }
      // 凹凸(数III)。**変曲点の x だけ受け取り、f″ の符号はこちらが出す。**
      let concave;
      let inflect;
      if (it.inflect) {
        const d2 = (x) => {
          const h = 1e-3;
          return (cv.f(x + h) - 2 * cv.f(x) + cv.f(x - h)) / (h * h);
        };
        inflect = it.inflect.slice().sort((a, b) => a - b);
        for (const c of inflect) {
          if (Math.abs(d2(c)) > 1e-3)
            throw new Error(`x=${c} は変曲点でない(f''=${d2(c).toFixed(4)})`);
        }
        const cuts2 = [lo, ...inflect, hi];
        concave = [];
        for (let i = 0; i < cuts2.length - 1; i++) {
          const s = d2((cuts2[i] + cuts2[i + 1]) / 2);
          concave.push(s > 0 ? "下に凸" : s < 0 ? "上に凸" : "—");
        }
      }
      draws.push({
        t: "signTable",
        curve: it.signTable,
        crit,
        sign, // 区間の符号
        arrow: sign.map((s) => (s === "+" ? "↗" : s === "-" ? "↘" : "→")),
        values: crit.map((c) => ({ x: c, y: cv.f(c), d: d1(c) })),
        inflect,
        concave,
      });
    } else if (it.states) {
      // 状態は名前だけ受け取り、**並べるのはこちら**(円形に置く)
      const n = it.states.length;
      if (n < 2) throw new Error("状態が2つ未満");
      states = it.states.map((nm, i) => {
        const a = Math.PI / 2 + (2 * Math.PI * i) / n;
        const p = { x: 3 * Math.cos(a), y: 3 * Math.sin(a) };
        pts[nm] = p;
        return { name: nm, p };
      });
      draws.push({ t: "states", states });
    } else if (it.edges) {
      if (!states.length) throw new Error("states より先に edges が来た");
      const known = new Set(states.map((s) => s.name));
      const es = it.edges.map(([from, to, prob]) => {
        if (!known.has(from)) throw new Error(`知らない状態: ${from}`);
        if (!known.has(to)) throw new Error(`知らない状態: ${to}`);
        const v = compile(String(prob), "_")(0);
        if (!Number.isFinite(v)) throw new Error(`確率が数でない: ${prob}`);
        return { from, to, prob: String(prob), value: v, self: from === to };
      });
      draws.push({ t: "edges", edges: es });
    } else if (it.seats) {
      // 円順列。**席の位置はこちらが等間隔に置く。**
      const n = it.seats;
      const labels = it.labels || [];
      if (labels.length && labels.length !== n)
        throw new Error(`席 ${n} に対して名前が ${labels.length} 個`);
      if (it.fix && !labels.includes(it.fix))
        throw new Error(`固定する人が名前の中にいない: ${it.fix}`);
      const seats = Array.from({ length: n }, (_, i) => {
        const a = Math.PI / 2 - (2 * Math.PI * i) / n; // 時計回り。上から始める
        return {
          name: labels[i],
          p: { x: 3 * Math.cos(a), y: 3 * Math.sin(a) },
          fixed: labels[i] === it.fix,
        };
      });
      seats.forEach((s) => {
        if (s.name) pts[s.name] = s.p;
      });
      draws.push({ t: "seats", seats, n, fix: it.fix });
    } else if (it.balls) {
      // 玉。**個数だけ受け取り、並べるのはこちら。**
      const kinds = Object.entries(it.balls);
      if (!kinds.length) throw new Error("玉が0種類");
      const list = [];
      kinds.forEach(([kind, count], ki) => {
        if (!Number.isInteger(count) || count < 0)
          throw new Error(`${kind} の個数が整数でない: ${count}`);
        for (let i = 0; i < count; i++) list.push({ kind, ki });
      });
      const cols = Math.ceil(Math.sqrt(list.length)) || 1;
      list.forEach((b, i) => {
        b.p = { x: (i % cols) - (cols - 1) / 2, y: -Math.floor(i / cols) };
      });
      draws.push({
        t: "balls",
        balls: list,
        kinds: Object.fromEntries(kinds),
        container: it.container,
      });
    } else if (it.dice) {
      // サイコロ。**目の数だけ受け取る。点の並びは目で決まっているので、こちらが置く。**
      const PIPS = {
        1: [[0, 0]],
        2: [
          [-1, 1],
          [1, -1],
        ],
        3: [
          [-1, 1],
          [0, 0],
          [1, -1],
        ],
        4: [
          [-1, 1],
          [1, 1],
          [-1, -1],
          [1, -1],
        ],
        5: [
          [-1, 1],
          [1, 1],
          [0, 0],
          [-1, -1],
          [1, -1],
        ],
        6: [
          [-1, 1],
          [1, 1],
          [-1, 0],
          [1, 0],
          [-1, -1],
          [1, -1],
        ],
      };
      const faces = it.dice.map((v) => {
        if (!PIPS[v]) throw new Error(`サイコロの目が 1〜6 でない: ${v}`);
        return { value: v, pips: PIPS[v] };
      });
      draws.push({ t: "dice", faces });
    } else if (it.unitCircle) {
      // 単位円。三角方程式・不等式はこれで説明する。
      // **角度だけ受け取り、(cosθ, sinθ) はこちらが出す。**
      // **名前で参照できるようにしておく。**内部名 `__unit` にしていたせいで、
      // モデルが `{"pt":"P","on":"unitCircle","deg":30}` と書いて落ちていた。
      // 原点 O も置く(半径や動径を引きたくなるのは自然なので)。
      pts.O = pts.O ?? { x: 0, y: 0 };
      circles.unitCircle = { c: { x: 0, y: 0 }, r: 1 };
      const marks = (it.angles || []).map((deg) => {
        const a = (deg * Math.PI) / 180;
        const p = { x: Math.cos(a), y: Math.sin(a) };
        pts[`P${deg}`] = p;
        return { deg, p, label: `(${fmt(p.x)}, ${fmt(p.y)})` };
      });
      draws.push({
        t: "unitCircle",
        marks,
        arc: it.arc ? { from: it.arc[0], to: it.arc[1] } : undefined,
      });
    } else if (it.vec) {
      // ベクトル = 矢印。始点と終点は名前つきの点で指す。
      const [a, b] = it.vec;
      draws.push({ t: "vec", a: P(a), b: P(b), names: it.vec, label: it.label, as: it.as });
    } else if (it.numberLine) {
      // 数直線。**塗る区間と、白丸/黒丸を不等号から決める。**
      const span = it.numberLine;
      const ranges = (it.ranges || []).map((r) => {
        if (r.from !== undefined && r.to !== undefined && r.from > r.to)
          throw new Error(`区間の向きが逆: ${r.from} > ${r.to}`);
        return {
          from: r.from ?? Number.NEGATIVE_INFINITY,
          to: r.to ?? Number.POSITIVE_INFINITY,
          closedFrom: !!r.closedFrom,
          closedTo: !!r.closedTo,
          as: r.as,
        };
      });
      draws.push({ t: "numberLine", span, ticks: it.ticks, ranges, marks: it.marks });
    } else if (it.ranges) {
      // `ranges` を別の要素として書いてくることがある。**直前の数直線に足す。**
      // ここを「知らないキー」で落としていたが、書き方として自然なので受ける。
      const nl = [...draws].reverse().find((d) => d.t === "numberLine");
      if (!nl) throw new Error("ranges の前に numberLine がない");
      it.ranges.forEach((r) =>
        nl.ranges.push({
          from: r.from ?? Number.NEGATIVE_INFINITY,
          to: r.to ?? Number.POSITIVE_INFINITY,
          closedFrom: !!r.closedFrom,
          closedTo: !!r.closedTo,
          as: r.as,
        }),
      );
    } else if (it.region) {
      // 不等式の表す領域。**式と不等号だけ受け取り、内外の判定はこちらがやる。**
      // 連立は配列で渡す。半平面も円の内外も、これ1つで入る。
      const specs = (Array.isArray(it.region[0]) ? it.region : [it.region]).map(([expr, sign]) => {
        if (!["<", ">", "<=", ">="].includes(sign)) throw new Error(`不等号が違う: ${sign}`);
        return { expr, sign, f: compile2(expr) };
      });
      const inside = (x, y) =>
        specs.every((s) => {
          const v = s.f(x, y);
          return s.sign[0] === "<"
            ? s.sign === "<"
              ? v < 0
              : v <= 0
            : s.sign === ">"
              ? v > 0
              : v >= 0;
        });
      const sp = it.span || [-5, 5, -5, 5];
      const cells = [];
      for (let i = 0; i <= 60; i++)
        for (let j = 0; j <= 60; j++) {
          const x = sp[0] + ((sp[1] - sp[0]) * i) / 60;
          const y = sp[2] + ((sp[3] - sp[2]) * j) / 60;
          if (inside(x, y)) cells.push({ x, y });
        }
      draws.push({
        t: "region",
        specs: specs.map((s) => ({ expr: s.expr, sign: s.sign })),
        inside,
        cells,
        span: sp,
        as: it.as,
      });
    } else if (it.boxplot) {
      // 箱ひげ図。**データを受け取り、五数要約はこちらが計算する。**
      const data = it.boxplot;
      if (!Array.isArray(data) || data.length < 4) throw new Error("データが足りない(4個以上)");
      if (data.some((v) => typeof v !== "number" || !Number.isFinite(v)))
        throw new Error("データに数でないものがある");
      draws.push({ t: "boxplot", data, five: fiveNumber(data), label: it.label });
    } else if (it.histogram) {
      // ヒストグラム。**度数はこちらが数える。**
      const data = it.histogram;
      const w = it.binWidth;
      if (!Array.isArray(data) || !data.length) throw new Error("データが無い");
      if (!(w > 0)) throw new Error(`binWidth が正でない: ${w}`);
      const from = it.from ?? Math.floor(Math.min(...data) / w) * w;
      const to = it.to ?? Math.ceil(Math.max(...data) / w) * w;
      const bins = [];
      for (let a = from; a < to - 1e-9; a += w) {
        const b = a + w;
        bins.push({
          from: a,
          to: b,
          n: data.filter((v) => v >= a && (b >= to ? v <= b : v < b)).length,
        });
      }
      draws.push({ t: "histogram", data, bins, binWidth: w });
    } else if (it.scatter) {
      // 散布図。**相関係数はこちらが計算する。**
      const ps = it.scatter;
      if (!Array.isArray(ps) || ps.length < 3) throw new Error("点が足りない(3個以上)");
      const xs = ps.map((p) => p[0]);
      const ys = ps.map((p) => p[1]);
      const n = ps.length;
      const mx = xs.reduce((a, c) => a + c, 0) / n;
      const my = ys.reduce((a, c) => a + c, 0) / n;
      const sxy = xs.reduce((a, _, i) => a + (xs[i] - mx) * (ys[i] - my), 0) / n;
      const sx = Math.sqrt(xs.reduce((a, v) => a + (v - mx) ** 2, 0) / n);
      const sy = Math.sqrt(ys.reduce((a, v) => a + (v - my) ** 2, 0) / n);
      draws.push({ t: "scatter", ps, r: sxy / (sx * sy), mean: { x: mx, y: my } });
    } else if (it.tree) {
      // 樹形図。**枝だけ受け取り、並べるのと葉を数えるのはこちら。**
      const levels = it.tree; // [["表","裏"],["表","裏"],...]
      if (!Array.isArray(levels) || !levels.length) throw new Error("枝が無い");
      let paths = [[]];
      for (const opts of levels) {
        if (!Array.isArray(opts) || !opts.length) throw new Error("枝の選択肢が空");
        paths = paths.flatMap((p) => opts.map((o) => [...p, o]));
      }
      draws.push({ t: "tree", levels, paths, leaves: paths.length });
    } else if (it.venn) {
      // ベン図。**各領域の個数を受け取り、合計が全体と合うかはこちらが見る。**
      const sets = it.venn;
      const counts = it.counts || {};
      if (sets.length < 2 || sets.length > 3) throw new Error("集合は2つか3つ");
      const total = Object.values(counts).reduce((a, c) => a + c, 0);
      draws.push({ t: "venn", sets, counts, total, universe: it.universe });
    } else if (it.lattice) {
      // 格子点。**範囲と条件を受け取り、数えるのはこちら。**
      const [x0, x1, y0, y1] = it.lattice;
      const f = it.where ? compile2(it.where) : null;
      const ps = [];
      for (let x = Math.ceil(x0); x <= x1; x++)
        for (let y = Math.ceil(y0); y <= y1; y++) {
          if (!f || f(x, y) >= 0) ps.push({ x, y });
        }
      draws.push({ t: "lattice", ps, span: it.lattice, where: it.where, count: ps.length });
    } else if (it.normal) {
      // 正規分布。**斜線部の確率はこちらが積分する。**
      const { mu = 0, sigma = 1 } = it.normal;
      if (!(sigma > 0)) throw new Error("標準偏差が正でない");
      const sh = it.shade;
      const z = (v) => (v - mu) / sigma;
      const area = sh
        ? normalCdf(z(sh[1] ?? Number.POSITIVE_INFINITY)) -
          normalCdf(z(sh[0] ?? Number.NEGATIVE_INFINITY))
        : undefined;
      draws.push({ t: "normal", mu, sigma, shade: sh, area, label: it.label });
    } else if (it.conic) {
      // 2次曲線。**a と b だけ受け取り、焦点・漸近線・準線はこちらが出す。**
      const { conic, a, b } = it;
      if (!(a > 0)) throw new Error("a が正でない");
      const o = { x: 0, y: 0 };
      if (conic === "ellipse") {
        if (!(b > 0) || b > a) throw new Error("楕円は 0 < b <= a");
        const c = Math.sqrt(a * a - b * b);
        pts.F1 = { x: c, y: 0 };
        pts.F2 = { x: -c, y: 0 };
        draws.push({ t: "conic", kind: "ellipse", a, b, c, foci: [pts.F1, pts.F2], center: o });
      } else if (conic === "hyperbola") {
        if (!(b > 0)) throw new Error("双曲線は b > 0");
        const c = Math.sqrt(a * a + b * b);
        pts.F1 = { x: c, y: 0 };
        pts.F2 = { x: -c, y: 0 };
        draws.push({
          t: "conic",
          kind: "hyperbola",
          a,
          b,
          c,
          foci: [pts.F1, pts.F2],
          center: o,
          asymptotes: [b / a, -b / a],
        });
      } else if (conic === "parabola") {
        // y^2 = 4ax。焦点 (a,0)、準線 x = -a
        pts.F1 = { x: a, y: 0 };
        draws.push({ t: "conic", kind: "parabola", a, foci: [pts.F1], directrix: -a, center: o });
      } else throw new Error(`知らない2次曲線: ${conic}`);
    } else if (it.complexPlane) {
      // 複素数平面。**回転・実数倍の結果はこちらが計算する。**
      // 原点は必ず置く(原点との線分を引きたくなるのが普通で、無いと落ちていた)。
      pts.O = pts.O ?? { x: 0, y: 0 };
      const zs = {};
      // **与えられた点も描く。**登録するだけだと、元の点が図に出ない。
      Object.entries(it.points || {}).forEach(([nm, v]) => {
        zs[nm] = { x: v[0], y: v[1] };
        pts[nm] = zs[nm];
        draws.push({ t: "pt", p: zs[nm], name: nm, coord: `(${fmt(v[0])}, ${fmt(v[1])})` });
        draws.push({
          t: "seg",
          a: { x: 0, y: 0 },
          b: zs[nm],
          names: ["O", nm],
          as: "aux",
          length: Math.hypot(v[0], v[1]),
        });
      });
      (it.ops || []).forEach((op) => {
        const src = pts[op.of];
        if (!src) throw new Error(`未定義の複素数: ${op.of}`);
        const a = ((op.deg || 0) * Math.PI) / 180;
        const k = op.times ?? 1;
        pts[op.to] = {
          x: k * (src.x * Math.cos(a) - src.y * Math.sin(a)),
          y: k * (src.x * Math.sin(a) + src.y * Math.cos(a)),
        };
        draws.push({
          t: "pt",
          p: pts[op.to],
          name: op.to,
          coord: `(${fmt(pts[op.to].x)}, ${fmt(pts[op.to].y)})`,
        });
        draws.push({
          t: "seg",
          a: { x: 0, y: 0 },
          b: pts[op.to],
          names: ["O", op.to],
          as: "key",
          length: Math.hypot(pts[op.to].x, pts[op.to].y),
        });
      });
      draws.push({ t: "complexPlane", points: Object.keys(pts), span: it.span || 4 });
    } else if (it.polar) {
      // 極方程式 r = f(θ)。**直交座標への変換はこちら。**
      const f = compile(it.polar, "t");
      const d = it.domain || [0, 2 * Math.PI];
      const ps = [];
      for (let i = 0; i <= 240; i++) {
        const th = d[0] + ((d[1] - d[0]) * i) / 240;
        const r = f(th);
        if (Number.isFinite(r)) ps.push({ x: r * Math.cos(th), y: r * Math.sin(th), th, r });
      }
      if (!ps.length) throw new Error("極方程式が1点も引けない");
      curves[it.name || "polar"] = {
        px: (t) => f(t) * Math.cos(t),
        py: (t) => f(t) * Math.sin(t),
        domain: d,
        param: true,
      };
      draws.push({ t: "curve", ps, polar: it.polar, as: it.as });
    } else if (it.asymptote) {
      // 漸近線。縦 {x:a} か横 {y:b} か、傾きつき {slope,intercept}
      const a = it.asymptote;
      if (a.x === undefined && a.y === undefined && a.slope === undefined)
        throw new Error("漸近線の指定が無い");
      draws.push({ t: "asymptote", ...a, as: "aux" });
    } else if (it.riemann) {
      // 区分求積の短冊。**本数だけ受け取り、高さも面積の和もこちらが出す。**
      const cv = curves[it.riemann];
      if (!cv) throw new Error(`未定義の曲線: ${it.riemann}`);
      if (!cv.f) throw new Error(`y=f(x) の形でない: ${it.riemann}`);
      const n = it.n;
      const [x0, x1] = it.range || cv.domain;
      if (!Number.isInteger(n) || n < 1) throw new Error(`短冊の本数が整数でない: ${n}`);
      const w = (x1 - x0) / n;
      const bars = [];
      for (let i = 0; i < n; i++) {
        const left = x0 + i * w;
        const at = it.side === "right" ? left + w : it.side === "mid" ? left + w / 2 : left;
        bars.push({ from: left, to: left + w, h: cv.f(at) });
      }
      draws.push({ t: "riemann", bars, n, sum: bars.reduce((a, c) => a + c.h * w, 0), width: w });
    } else if (it.groups) {
      // 群数列の区切り。**各群の項数だけ受け取り、区切り位置はこちらが積み上げる。**
      const sizes = it.groups;
      if (!Array.isArray(sizes) || sizes.some((v) => !Number.isInteger(v) || v < 1))
        throw new Error("群の項数が整数でない");
      let k = 0;
      const gs = sizes.map((n, i) => {
        const from = k + 1;
        k += n;
        return { i: i + 1, from, to: k, n };
      });
      draws.push({ t: "groups", groups: gs, total: k, terms: it.terms });
    } else if (it.diceTable) {
      const cells = [];
      for (let a = 1; a <= 6; a++)
        for (let b = 1; b <= 6; b++) {
          const mark =
            it.markSum !== undefined
              ? a + b === it.markSum
              : it.markDiff !== undefined
                ? Math.abs(a - b) === it.markDiff
                : false;
          cells.push({ a, b, mark });
        }
      draws.push({
        t: "diceTable",
        cells,
        marked: cells.filter((c) => c.mark).length,
        markSum: it.markSum,
      });
    } else if (it.curve) {
      curves[it.curve] = normalizeCurve(it);
      if (!it.hidden)
        draws.push({
          t: "curve",
          name: it.curve,
          ps: sample(curves[it.curve]),
          as: it.as,
          dash: !!it.dash,
        });
    } else if (it.revolve) {
      const cv = curves[it.revolve];
      if (!cv) throw new Error(`未定義の曲線を回そうとした: ${it.revolve}`);
      const k = 0.26;
      const ax = it.around && it.around.x !== undefined ? it.around : { y: it.around?.y || 0 };
      const base = sample(cv, it.range);
      draws.push({ t: "curve", ps: base, as: it.as, revolveTop: true });
      draws.push({
        t: "curve",
        ps: base.map((p) => mirrorAbout(p, ax)),
        as: it.as,
        revolveBottom: true,
      });
      const xs0 = base.map((p) => p.x);
      const ys0 = base.map((p) => p.y);
      if (ax.x !== undefined)
        draws.push({
          t: "seg",
          a: { x: ax.x, y: Math.min(...ys0) },
          b: { x: ax.x, y: Math.max(...ys0) },
          as: "aux",
          axis: true,
        });
      else
        draws.push({
          t: "seg",
          a: { x: Math.min(...xs0), y: ax.y },
          b: { x: Math.max(...xs0), y: ax.y },
          as: "aux",
          axis: true,
        });
      [base[0], base[base.length - 1]].forEach((p, i) => {
        const r = radiusTo(p, ax);
        if (r < 1e-6) return;
        const c0 = ax.x !== undefined ? { x: ax.x, y: p.y } : { x: p.x, y: ax.y };
        draws.push({
          t: "ellipse",
          c: c0,
          rx: ax.x !== undefined ? r : r * k,
          ry: ax.x !== undefined ? r * k : r,
          as: i === 1 ? it.capAs : undefined,
          cap: true,
        });
      });
    } else if (it.fillUnder) {
      const cu = sample(curves[it.fillUnder], it.range);
      draws.push({
        t: "poly",
        fill: true,
        as: it.as,
        ps: [{ x: cu[0].x, y: 0 }, ...cu, { x: cu[cu.length - 1].x, y: 0 }],
      });
    } else if (it.fillBetween) {
      const c1 = curves[it.fillBetween[0]];
      const c2 = curves[it.fillBetween[1]];
      if (!c1 || !c2) throw new Error(`未定義の曲線を塗ろうとした: ${it.fillBetween}`);
      const x0 = P(it.from).x;
      const x1 = P(it.to).x;
      const up = sample(c1, [x0, x1]);
      const down = sample(c2, [x0, x1]).reverse();
      draws.push({ t: "poly", ps: up.concat(down), fill: true, as: it.as, open: true });
    } else if (it.arc)
      draws.push({
        t: "arc",
        a: P(it.arc[0]),
        o: P(it.arc[1]),
        b: P(it.arc[2]),
        names: it.arc,
        label: it.label,
      });
    else if (it.right)
      draws.push({
        t: "right",
        a: P(it.right[0]),
        o: P(it.right[1]),
        b: P(it.right[2]),
        names: it.right,
      });
    else throw new Error(`知らないキー: ${JSON.stringify(Object.keys(it))}`);
  }

  // **比のラベル(`part`)は、実際の長さの比と合っていなければ通さない。**
  // 「BD:DC = 3:2」を長さラベルで書くと必ず食い違う(3 は長さではない)ので、
  // 比は比として書かせ、比として検算する。
  const parts = draws.filter((d) => d.t === "seg" && d.part !== undefined);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const [u, v] = [parts[i], parts[j]];
      const want = Number(u.part) / Number(v.part);
      const got = u.length / v.length;
      if (!Number.isFinite(want) || want <= 0) throw new Error(`比が数でない: ${u.part}`);
      if (Math.abs(got - want) / want > 0.02) {
        throw new Error(
          `${u.names.join("")}:${v.names.join("")} を ${u.part}:${v.part} と書いたが、実際は ${got.toFixed(3)}:1`,
        );
      }
    }
  }
  return { draws, pts, circles, curves, lines };
}

function normalizeCurve(it) {
  if (it.px)
    return { px: compile(it.px, "t"), py: compile(it.py, "t"), domain: it.domain, param: true };
  if (it.of === "y") {
    const g = compile(it.f, "y");
    return { px: g, py: (t) => t, domain: it.domain, g };
  }
  const f = compile(it.f, "x");
  return { px: (t) => t, py: f, domain: it.domain, f };
}

function sample(cv, range) {
  const d = range || cv.domain;
  if (!d) throw new Error("domain が無い曲線");
  const out = [];
  for (let i = 0; i <= 120; i++) {
    const t = d[0] + ((d[1] - d[0]) * i) / 120;
    const x = cv.px(t);
    const y = cv.py(t);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  if (!out.length) throw new Error("曲線が1点も引けない");
  return out;
}

// o から a へ向かう単位ベクトル。角の二等分線の向きを出すのに使う。
function norm(a, o) {
  const dx = a.x - o.x;
  const dy = a.y - o.y;
  const n = Math.hypot(dx, dy) || 1;
  return { x: dx / n, y: dy / n };
}

const mirrorAbout = (p, ax) =>
  ax.x !== undefined ? { x: 2 * ax.x - p.x, y: p.y } : { x: p.x, y: 2 * ax.y - p.y };
const radiusTo = (p, ax) => (ax.x !== undefined ? Math.abs(p.x - ax.x) : Math.abs(p.y - ax.y));

function crossing(ca, cb, near) {
  const lo = Math.max(ca.domain[0], cb.domain[0]);
  const hi = Math.min(ca.domain[1], cb.domain[1]);
  const h = (x) => ca.py(x) - cb.py(x);
  let best = null;
  let prev = h(lo);
  let px = lo;
  for (let i = 1; i <= 400; i++) {
    const x = lo + ((hi - lo) * i) / 400;
    const cur = h(x);
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev * cur <= 0) {
      let a = px;
      let b = x;
      for (let k = 0; k < 60; k++) {
        const m = (a + b) / 2;
        if (h(a) * h(m) <= 0) b = m;
        else a = m;
      }
      const r = (a + b) / 2;
      if (best === null || Math.abs(r - near) < Math.abs(best - near)) best = r;
    }
    prev = cur;
    px = x;
  }
  return best;
}

function project(p) {
  const k = 0.56;
  const a = (40 * Math.PI) / 180;
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
  const a = l1.a;
  const x1 = l1.b.x - a.x;
  const y1 = l1.b.y - a.y;
  const c = l2.a;
  const x2 = l2.b.x - c.x;
  const y2 = l2.b.y - c.y;
  const den = x1 * y2 - y1 * x2;
  if (Math.abs(den) < 1e-9) throw new Error("平行な2直線の交点を取ろうとした");
  const t = ((c.x - a.x) * y2 - (c.y - a.y) * x2) / den;
  return { x: a.x + t * x1, y: a.y + t * y1 };
}

function meetCircles(k1, k2) {
  if (!k1 || !k2) throw new Error("未定義の円");
  const dx = k2.c.x - k1.c.x;
  const dy = k2.c.y - k1.c.y;
  const d = Math.hypot(dx, dy);
  if (d > k1.r + k2.r || d < Math.abs(k1.r - k2.r) || d === 0) return null;
  const a = (k1.r * k1.r - k2.r * k2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(k1.r * k1.r - a * a, 0));
  const mx = k1.c.x + (a * dx) / d;
  const my = k1.c.y + (a * dy) / d;
  return [
    { x: mx - (h * dy) / d, y: my + (h * dx) / d },
    { x: mx + (h * dy) / d, y: my - (h * dx) / d },
  ];
}

function secondMeet(k, line, other) {
  if (!k) throw new Error("未定義の円");
  let ux = line.b.x - line.a.x;
  let uy = line.b.y - line.a.y;
  const n = Math.hypot(ux, uy);
  ux /= n;
  uy /= n;
  const wx = line.a.x - k.c.x;
  const wy = line.a.y - k.c.y;
  const b = ux * wx + uy * wy;
  const cc = wx * wx + wy * wy - k.r * k.r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const cands = [-b + s, -b - s].map((t) => ({ x: line.a.x + t * ux, y: line.a.y + t * uy }));
  if (!other) return cands[0];
  return Math.hypot(cands[0].x - other.x, cands[0].y - other.y) >
    Math.hypot(cands[1].x - other.x, cands[1].y - other.y)
    ? cands[0]
    : cands[1];
}
