// 全40問。**採点は「描けたか」ではなく「図が正しいか」**。
// どれも「作図で組み立てたときだけ成り立ち、座標を当てずっぽうで書くと崩れる」量を測る。

// 配送済みの実物は保存されていなかったため、報告の4分類を最小入力に正規化したfixtureを
// package側と共有する。check.mjs が毎回「検出でき、修正後は通る」ことを先に検算する。
export {
  figureQualityFixtures as READABILITY_FIXTURES,
  readableFigureFixture as READABLE_FIGURE_FIXTURE,
} from "../../packages/figure/src/quality-fixtures.js";

const deg = (a, o, b) => {
  const u = Math.atan2(a.y - o.y, a.x - o.x);
  const v = Math.atan2(b.y - o.y, b.x - o.x);
  const d = Math.abs(((u - v) * 180) / Math.PI) % 360;
  return d > 180 ? 360 - d : d;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const segs = (r) => r.draws.filter((d) => d.t === "seg" && d.names);
const hasSeg = (r, x, y) =>
  segs(r).some(
    (s) => (s.names[0] === x && s.names[1] === y) || (s.names[0] === y && s.names[1] === x),
  );
const curveOf = (r, i) => Object.values(r.curves)[i];

export const PROBLEMS = [
  {
    id: "centroid",
    tag: "平面・基本",
    prompt: "三角形ABCの3本の中線が1点(重心G)で交わることを説明したい。その図を描いて。",
    check(r) {
      const g = Object.entries(r.pts).find(([, p]) => Object.keys(r.pts).length >= 4 && p);
      // 重心の真の位置を、頂点3つから求める(名前は A,B,C を想定)
      const { A, B, C } = r.pts;
      if (!A || !B || !C) return { ok: false, why: "A,B,C が無い" };
      const truth = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
      const hit = Object.entries(r.pts).find(
        ([n, p]) => n !== "A" && n !== "B" && n !== "C" && dist(p, truth) < 1e-6,
      );
      if (!hit) return { ok: false, why: "重心の位置にある点が無い(=3本目が交わっていない)" };
      const medians = ["A", "B", "C"].filter((v) => {
        const [x, y] = ["A", "B", "C"].filter((o) => o !== v);
        const m = { x: (r.pts[x].x + r.pts[y].x) / 2, y: (r.pts[x].y + r.pts[y].y) / 2 };
        return segs(r).some((s) => {
          const [p, q] = [s.a, s.b];
          const on = (u, w) =>
            dist(u, r.pts[v]) < 1e-6 && (dist(w, m) < 1e-6 || dist(w, truth) < 1e-6);
          return on(p, q) || on(q, p);
        });
      }).length;
      if (medians < 3) return { ok: false, why: `中線が ${medians}/3 本しか引かれていない` };
      return { ok: true, why: `重心一致 ${dist(hit[1], truth).toExponential(1)}、中線3本` };
    },
  },
  {
    id: "thales",
    tag: "円・むずかしい",
    prompt:
      "円Oの直径をABとする。円周上の点Pについて ∠APB = 90° になることを説明したい。その図を描いて。",
    check(r) {
      const { A, B } = r.pts;
      if (!A || !B) return { ok: false, why: "A,B が無い" };
      const K = Object.values(r.circles)[0];
      if (!K) return { ok: false, why: "円が無い" };
      if (Math.abs(dist(A, B) - 2 * K.r) > 1e-6)
        return { ok: false, why: "AB が直径になっていない" };
      const P =
        r.pts.P ||
        Object.entries(r.pts).find(
          ([n, p]) => !"AB".includes(n) && Math.abs(dist(p, K.c) - K.r) < 1e-6,
        )?.[1];
      if (!P) return { ok: false, why: "円周上の第3の点が無い" };
      const a = deg(A, P, B);
      return Math.abs(a - 90) < 0.5
        ? { ok: true, why: `∠APB = ${a.toFixed(3)}°` }
        : { ok: false, why: `∠APB = ${a.toFixed(2)}°(90°になっていない)` };
    },
  },
  {
    id: "tangent",
    tag: "円・接線",
    prompt:
      "円Oの周上に3点A,B,Cがある。点Aにおける円の接線をATとするとき、接弦定理 ∠TAB = ∠ACB を説明したい。その図を描いて。",
    check(r) {
      const { A, B, C } = r.pts;
      const K = Object.values(r.circles)[0];
      if (!A || !B || !C || !K) return { ok: false, why: "A,B,C か円が足りない" };
      for (const [n, p] of [
        ["A", A],
        ["B", B],
        ["C", C],
      ]) {
        if (Math.abs(dist(p, K.c) - K.r) > 1e-6) return { ok: false, why: `${n} が円周上にない` };
      }
      const T = r.pts.T;
      if (!T) return { ok: false, why: "接点方向の点 T が無い" };
      // 接線であること = OA ⊥ AT
      const perp = deg(r.pts.O ?? K.c, A, T);
      if (Math.abs(perp - 90) > 0.5)
        return { ok: false, why: `AT が接線でない(OA との角 ${perp.toFixed(2)}°)` };
      const l = deg(T, A, B);
      const rgt = deg(A, C, B);
      return Math.abs(l - rgt) < 0.5
        ? { ok: true, why: `∠TAB = ${l.toFixed(3)}°, ∠ACB = ${rgt.toFixed(3)}°` }
        : { ok: false, why: `∠TAB = ${l.toFixed(2)}° だが ∠ACB = ${rgt.toFixed(2)}°` };
    },
  },
  {
    id: "ratio",
    tag: "平面・内分",
    prompt: "三角形ABCの辺BC上に、BD:DC = 3:2 となる点Dをとる。AとDを結ぶ。その図を描いて。",
    check(r) {
      const { A, B, C, D } = r.pts;
      if (!A || !B || !C || !D) return { ok: false, why: "A,B,C,D が足りない" };
      const cross = Math.abs((C.x - B.x) * (D.y - B.y) - (C.y - B.y) * (D.x - B.x));
      if (cross > 1e-6) return { ok: false, why: "D が BC 上にない" };
      const k = dist(B, D) / dist(D, C);
      if (Math.abs(k - 1.5) > 1e-6)
        return { ok: false, why: `BD:DC = ${k.toFixed(4)}:1(1.5:1 のはず)` };
      if (!hasSeg(r, "A", "D")) return { ok: false, why: "AD が引かれていない" };
      return { ok: true, why: `BD:DC = ${k.toFixed(6)}:1、AD あり` };
    },
  },
  {
    id: "box",
    tag: "空間",
    prompt: "直方体ABCD-EFGHがある。対角線AGを引いた図を描いて。",
    check(r) {
      const b = r.draws.find((d) => d.t === "box3");
      if (!b) return { ok: false, why: "直方体が無い(box3 を使っていない)" };
      if (b.labels.length !== 8) return { ok: false, why: "頂点が8つない" };
      const idx = (n) => b.labels.indexOf(n);
      const diag = segs(r).find((s) => {
        const [i, j] = s.names.map(idx);
        if (i < 0 || j < 0) return false;
        return b.v3[i].every((v, k) => v !== b.v3[j][k]); // 3方向すべて違う = 空間対角線
      });
      if (!diag) return { ok: false, why: "空間対角線が引かれていない" };
      return { ok: true, why: `対角線 ${diag.names.join("")}、隠れ頂点 ${b.hidden}` };
    },
  },
  {
    id: "parabola",
    tag: "関数・面積",
    prompt: "放物線 y = x^2 と直線 y = x で囲まれた部分を図示して。",
    check(r) {
      const cs = Object.values(r.curves);
      if (cs.length < 2) return { ok: false, why: `曲線が ${cs.length} 本しかない` };
      const fill = r.draws.find((d) => d.t === "poly" && d.fill);
      if (!fill) return { ok: false, why: "囲まれた部分が塗られていない" };
      // 塗られた領域が (0,0)-(1,1) に収まり、面積が 1/6 に近いか
      const xs = fill.ps.map((p) => p.x);
      const ys = fill.ps.map((p) => p.y);
      let area = 0;
      for (let i = 0; i < fill.ps.length; i++) {
        const p = fill.ps[i];
        const q = fill.ps[(i + 1) % fill.ps.length];
        area += p.x * q.y - q.x * p.y;
      }
      area = Math.abs(area) / 2;
      const box =
        Math.min(...xs) > -0.01 &&
        Math.max(...xs) < 1.01 &&
        Math.min(...ys) > -0.01 &&
        Math.max(...ys) < 1.01;
      if (!box)
        return {
          ok: false,
          why: `塗った範囲が [0,1]² を外れている (x:${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)})`,
        };
      return Math.abs(area - 1 / 6) < 0.005
        ? { ok: true, why: `面積 ${area.toFixed(4)}(1/6 = 0.1667)` }
        : { ok: false, why: `面積 ${area.toFixed(4)}(1/6 のはず)` };
    },
  },
  {
    id: "cycloid",
    tag: "媒介変数",
    prompt:
      "半径1の円がx軸上をすべらずに1回転するとき、円周上の定点が描く曲線(サイクロイド)を図示して。",
    check(r) {
      const cv = r.draws.find((d) => d.t === "curve");
      if (!cv) return { ok: false, why: "曲線が無い" };
      const ps = cv.ps;
      const s = ps[0];
      const e = ps[ps.length - 1];
      const top = Math.max(...ps.map((p) => p.y));
      const bad = [];
      if (dist(s, { x: 0, y: 0 }) > 0.05) bad.push(`始点 (${s.x.toFixed(2)},${s.y.toFixed(2)})`);
      if (dist(e, { x: 2 * Math.PI, y: 0 }) > 0.05)
        bad.push(`終点 (${e.x.toFixed(2)},${e.y.toFixed(2)})`);
      if (Math.abs(top - 2) > 0.02) bad.push(`最高点 y=${top.toFixed(3)}`);
      return bad.length
        ? { ok: false, why: `${bad.join(" / ")} が合わない` }
        : { ok: true, why: `(0,0)→(2π,0)、最高点 y=${top.toFixed(3)}` };
    },
  },
  {
    id: "revolve",
    tag: "回転体",
    prompt: "曲線 y = sqrt(x) (0 ≦ x ≦ 4) をx軸のまわりに1回転してできる立体を図示して。",
    check(r) {
      const top = r.draws.find((d) => d.revolveTop);
      if (!top) return { ok: false, why: "回転体になっていない(revolve を使っていない)" };
      const bot = r.draws.find((d) => d.revolveBottom);
      const caps = r.draws.filter((d) => d.cap);
      const t = top.ps;
      const lo = t[0];
      const hi = t[t.length - 1];
      const bad = [];
      if (Math.abs(lo.x) > 0.02 || Math.abs(lo.y) > 0.02)
        bad.push(`左端 (${lo.x.toFixed(2)},${lo.y.toFixed(2)})`);
      if (Math.abs(hi.x - 4) > 0.02 || Math.abs(hi.y - 2) > 0.02)
        bad.push(`右端 (${hi.x.toFixed(2)},${hi.y.toFixed(2)})`);
      if (!bot) bad.push("下半分が無い");
      if (!caps.length) bad.push("切り口が無い");
      else if (Math.abs(caps[caps.length - 1].ry - 2) > 0.02)
        bad.push(`切り口の半径 ${caps[caps.length - 1].ry.toFixed(2)}(2 のはず)`);
      return bad.length
        ? { ok: false, why: bad.join(" / ") }
        : { ok: true, why: "(0,0)→(4,2)、上下対称、切り口 r=2" };
    },
  },

  // ---- ここから、作図ではないもの ----
  {
    id: "coords",
    tag: "グラフ・座標",
    prompt: "放物線 y = x^2 - 4x + 3 のグラフを、頂点とx軸との交点の座標がわかるように図示して。",
    check(r) {
      const ax = r.draws.find((d) => d.t === "axes");
      if (!ax) return { ok: false, why: "座標軸が無い" };
      const shown = r.draws.filter((d) => d.t === "pt" && d.coord);
      if (shown.length < 3)
        return { ok: false, why: `座標を出した点が ${shown.length} 個(頂点+交点2つで3個ほしい)` };
      const want = [
        [2, -1],
        [1, 0],
        [3, 0],
      ];
      const miss = want.filter(
        ([x, y]) => !shown.some((s) => Math.abs(s.p.x - x) < 1e-6 && Math.abs(s.p.y - y) < 1e-6),
      );
      if (miss.length)
        return { ok: false, why: `${miss.map((m) => `(${m})`).join(" ")} が出ていない` };
      // **目盛りは要求していない。**問題文は「座標がわかるように」なので、
      // 3点に座標が出ていれば要件は満たしている。ここを必須にしていたのは私の採点が厳しすぎた。
      const tick = ax.ticks?.length ? `、目盛り ${ax.ticks.length} 個` : "(目盛りなし)";
      return { ok: true, why: `頂点(2,-1)・交点(1,0)(3,0)${tick}` };
    },
  },
  {
    id: "signtable",
    tag: "増減表",
    prompt: "y = x^3 - 3x の増減表をかいて、グラフの概形も示して。",
    check(r) {
      const t = r.draws.find((d) => d.t === "signTable");
      if (!t) return { ok: false, why: "増減表が無い(signTable を使っていない)" };
      const c = t.crit;
      if (c.length !== 2 || Math.abs(c[0] + 1) > 1e-9 || Math.abs(c[1] - 1) > 1e-9) {
        return { ok: false, why: `極値の x が [${c}](-1, 1 のはず)` };
      }
      if (t.sign.join("") !== "+-+")
        return { ok: false, why: `f' の符号が ${t.sign.join("")}(+-+ のはず)` };
      const ys = t.values.map((v) => v.y);
      if (Math.abs(ys[0] - 2) > 1e-4 || Math.abs(ys[1] + 2) > 1e-4) {
        return { ok: false, why: `極値が ${ys.map((y) => y.toFixed(2))}(2, -2 のはず)` };
      }
      if (!r.draws.some((d) => d.t === "curve")) return { ok: false, why: "グラフの概形が無い" };
      return { ok: true, why: `x=-1,1 / 符号 +-+ / 極大2・極小-2 / 矢印 ${t.arrow.join("")}` };
    },
  },
  {
    id: "markov",
    tag: "遷移図",
    prompt:
      "A, B, C の3つの箱があり、毎回次のように移る。Aにいるとき1/2でBへ、1/2でCへ。Bにいるとき1/3でAへ、2/3でCへ。Cにいるときは必ずAへ戻る。この移り方の図をかいて。",
    check(r) {
      const s = r.draws.find((d) => d.t === "states");
      const e = r.draws.find((d) => d.t === "edges");
      if (!s) return { ok: false, why: "状態が無い" };
      if (!e) return { ok: false, why: "矢印が無い" };
      if (s.states.length !== 3)
        return { ok: false, why: `状態が ${s.states.length} 個(3個のはず)` };
      // **出ていく確率の合計が1**。これが合わない遷移図は、絵として自然でも間違い
      const bad = [];
      for (const st of s.states) {
        const sum = e.edges.filter((x) => x.from === st.name).reduce((a, x) => a + x.value, 0);
        if (Math.abs(sum - 1) > 1e-9) bad.push(`${st.name} から出る確率の和 = ${sum.toFixed(3)}`);
      }
      if (bad.length) return { ok: false, why: bad.join(" / ") };
      const want = [
        ["A", "B", 0.5],
        ["A", "C", 0.5],
        ["B", "A", 1 / 3],
        ["B", "C", 2 / 3],
        ["C", "A", 1],
      ];
      const miss = want.filter(
        ([f, t, v]) =>
          !e.edges.some((x) => x.from === f && x.to === t && Math.abs(x.value - v) < 1e-9),
      );
      if (miss.length)
        return {
          ok: false,
          why: `${miss.map((m) => `${m[0]}→${m[1]}`).join(" ")} が無い/確率違い`,
        };
      if (e.edges.length !== 5) return { ok: false, why: `矢印が ${e.edges.length} 本(5本のはず)` };
      return { ok: true, why: "3状態5本、どの状態も出る確率の和が 1" };
    },
  },
  {
    id: "selfloop",
    tag: "遷移図・自己ループ",
    prompt:
      "点PははじめA地点にいる。1回の操作で、確率1/4でとどまり、確率3/4でB地点へ移る。B地点からは確率1でA地点へ戻る。この様子を図にして。",
    check(r) {
      const s = r.draws.find((d) => d.t === "states");
      const e = r.draws.find((d) => d.t === "edges");
      if (!s || !e) return { ok: false, why: "状態か矢印が無い" };
      const loop = e.edges.filter((x) => x.self);
      if (!loop.length)
        return { ok: false, why: "自分に戻る矢印が無い(とどまる確率が描けていない)" };
      if (Math.abs(loop[0].value - 0.25) > 1e-9)
        return { ok: false, why: `自己ループの確率が ${loop[0].value}(1/4 のはず)` };
      for (const st of s.states) {
        const sum = e.edges.filter((x) => x.from === st.name).reduce((a, x) => a + x.value, 0);
        if (Math.abs(sum - 1) > 1e-9)
          return { ok: false, why: `${st.name} から出る確率の和 = ${sum.toFixed(3)}` };
      }
      return { ok: true, why: "自己ループ 1/4、どの状態も和が 1" };
    },
  },
  {
    id: "seats",
    tag: "円順列",
    prompt: "6人が丸いテーブルに座る円順列を考えたい。1人を固定して考えることがわかる図をかいて。",
    check(r) {
      const s = r.draws.find((d) => d.t === "seats");
      if (!s) return { ok: false, why: "丸いテーブルが無い(seats を使っていない)" };
      if (s.n !== 6) return { ok: false, why: `席が ${s.n} 個(6個のはず)` };
      if (!s.fix)
        return { ok: false, why: "固定する人が指定されていない(円順列の要点が出ていない)" };
      // 席が等間隔か。**こちらが置いているので必ず通るが、通らなければソルバのバグ**
      const ps = s.seats.map((x) => x.p);
      const d = ps.map((p, i) => Math.hypot(p.x - ps[(i + 1) % 6].x, p.y - ps[(i + 1) % 6].y));
      if (Math.max(...d) - Math.min(...d) > 1e-9) return { ok: false, why: "席が等間隔でない" };
      return { ok: true, why: `6席・等間隔、${s.fix} を固定` };
    },
  },
  {
    id: "balls",
    tag: "玉",
    prompt: "袋の中に赤玉が4個、白玉が3個入っている。この袋から玉を取り出す問題の図をかいて。",
    check(r) {
      const b = r.draws.find((d) => d.t === "balls");
      if (!b) return { ok: false, why: "玉が無い(balls を使っていない)" };
      const n = Object.values(b.kinds).reduce((a, c) => a + c, 0);
      if (n !== 7) return { ok: false, why: `玉が合計 ${n} 個(7個のはず)` };
      const vals = Object.values(b.kinds).sort((x, y) => y - x);
      if (vals[0] !== 4 || vals[1] !== 3)
        return { ok: false, why: `内訳が ${JSON.stringify(b.kinds)}(4と3のはず)` };
      if (b.balls.length !== 7) return { ok: false, why: `描かれた玉が ${b.balls.length} 個` };
      return { ok: true, why: `${JSON.stringify(b.kinds)} = 7個` };
    },
  },
  {
    id: "dice",
    tag: "サイコロ",
    prompt: "大小2つのサイコロを振る。大きいほうが2、小さいほうが6の目が出たときの図をかいて。",
    check(r) {
      const d = r.draws.find((d) => d.t === "dice");
      if (!d) return { ok: false, why: "サイコロが無い(dice を使っていない)" };
      const vs = d.faces.map((f) => f.value);
      if (vs.length !== 2) return { ok: false, why: `サイコロが ${vs.length} 個` };
      if (!(vs.includes(2) && vs.includes(6))) return { ok: false, why: `目が ${vs}(2と6のはず)` };
      const bad = d.faces.filter((f) => f.pips.length !== f.value);
      if (bad.length) return { ok: false, why: "目の数と点の数が合っていない" };
      return { ok: true, why: `目 ${vs.join(" と ")}、点の数も一致` };
    },
  },
  {
    id: "dicetable",
    tag: "サイコロの表",
    prompt: "大小2つのサイコロを振って、出た目の和が7になる場合を、6×6の表で示して。",
    check(r) {
      const t = r.draws.find((d) => d.t === "diceTable");
      if (!t) return { ok: false, why: "表が無い(diceTable を使っていない)" };
      if (t.cells.length !== 36) return { ok: false, why: `マスが ${t.cells.length} 個` };
      if (t.markSum !== 7) return { ok: false, why: `印の条件が 和=${t.markSum}(7のはず)` };
      if (t.marked !== 6) return { ok: false, why: `印のついたマスが ${t.marked} 個(6個のはず)` };
      return { ok: true, why: "36マス、和が7のマスが6個" };
    },
  },

  // ---- 全単元カバレッジ(units.md のギャップから) ----
  {
    id: "numline",
    unit: "数I 数と式",
    tag: "数直線",
    prompt: "不等式 |x - 1| < 3 の解を数直線で示して。",
    check(r) {
      const nl = r.draws.find((d) => d.t === "numberLine");
      if (!nl) return { ok: false, why: "数直線が無い" };
      if (!nl.ranges.length) return { ok: false, why: "解の範囲が塗られていない" };
      const g = nl.ranges[0];
      if (Math.abs(g.from + 2) > 1e-9 || Math.abs(g.to - 4) > 1e-9) {
        return { ok: false, why: `範囲が ${g.from}〜${g.to}(-2〜4 のはず)` };
      }
      if (g.closedFrom || g.closedTo)
        return { ok: false, why: "端が黒丸になっている(< なので白丸)" };
      return { ok: true, why: "-2 < x < 4、両端とも白丸" };
    },
  },
  {
    id: "unitcircle",
    unit: "数II 三角関数",
    tag: "単位円",
    prompt: "0 ≦ θ < 2π のとき、sin θ = 1/2 を満たす θ を単位円で説明して。",
    check(r) {
      const u = r.draws.find((d) => d.t === "unitCircle");
      if (!u) return { ok: false, why: "単位円が無い" };
      const degs = u.marks.map((m) => ((m.deg % 360) + 360) % 360).sort((a, b) => a - b);
      if (degs.length < 2)
        return { ok: false, why: `印が ${degs.length} 個(30°と150°の2個ほしい)` };
      const want = [30, 150];
      const miss = want.filter((w) => !degs.some((d) => Math.abs(d - w) < 1e-6));
      if (miss.length)
        return { ok: false, why: `${miss.join("°,")}° が無い(印は ${degs.join("°,")}°)` };
      // 印の座標が本当に (cosθ, sinθ) か
      const bad = u.marks.filter((m) => Math.abs(m.p.y - Math.sin((m.deg * Math.PI) / 180)) > 1e-9);
      if (bad.length) return { ok: false, why: "印の座標が cos/sin と合っていない" };
      return { ok: true, why: "30°・150°、sin = 0.5 で一致" };
    },
  },
  {
    id: "vector",
    unit: "数C ベクトル",
    tag: "ベクトル",
    prompt: "三角形OABにおいて、辺ABを2:1に内分する点をPとする。OPベクトルを図で示して。",
    check(r) {
      const vs = r.draws.filter((d) => d.t === "vec");
      if (!vs.length) return { ok: false, why: "矢印が無い(vec を使っていない)" };
      const { O, A, B, P } = r.pts;
      if (!O || !A || !B || !P) return { ok: false, why: "O,A,B,P が足りない" };
      const k = Math.hypot(A.x - P.x, A.y - P.y) / Math.hypot(P.x - B.x, P.y - B.y);
      if (Math.abs(k - 2) > 1e-6)
        return { ok: false, why: `AP:PB = ${k.toFixed(4)}:1(2:1 のはず)` };
      const op = vs.find((v) => v.names[0] === "O" && v.names[1] === "P");
      if (!op) return { ok: false, why: "OP の矢印が無い" };
      return { ok: true, why: `AP:PB = 2:1、OP の矢印あり(矢印 ${vs.length} 本)` };
    },
  },
  {
    id: "region",
    unit: "数II 図形と方程式",
    tag: "領域",
    prompt: "連立不等式 x² + y² < 9 かつ y > x の表す領域を図示して。",
    check(r) {
      const g = r.draws.find((d) => d.t === "region");
      if (!g) return { ok: false, why: "領域が無い(region を使っていない)" };
      // **標本点で内外を確かめる。**式の見た目ではなく、判定結果を見る
      const cases = [
        [0, 1, true],
        [-1, 2, true],
        [0, -1, false],
        [1, 0, false],
        // (2, 2.5) は y>x を満たすが 2²+2.5²=10.25>9 なので**円の外**。境界のすぐ外を1つ入れておく
        [0, 4, false],
        [3, 3, false],
        [-2, -1, true],
        [2, 2.5, false],
      ];
      const bad = cases.filter(([x, y, want]) => g.inside(x, y) !== want);
      if (bad.length) {
        const b = bad[0];
        return {
          ok: false,
          why: `(${b[0]},${b[1]}) を ${g.inside(b[0], b[1]) ? "内" : "外"} と判定(逆)`,
        };
      }
      if (!g.cells.length) return { ok: false, why: "塗る場所が1つも無い" };
      return { ok: true, why: "標本8点すべて正しく内外判定" };
    },
  },
  {
    id: "boxplot",
    unit: "数I データの分析",
    tag: "箱ひげ図",
    prompt: "次の9個のデータの箱ひげ図をかいて。12, 15, 18, 20, 22, 25, 28, 30, 35",
    check(r) {
      const b = r.draws.find((d) => d.t === "boxplot");
      if (!b) return { ok: false, why: "箱ひげ図が無い" };
      const want = [12, 15, 18, 20, 22, 25, 28, 30, 35];
      if (b.data.length !== 9) return { ok: false, why: `データが ${b.data.length} 個(9個のはず)` };
      const miss = want.filter((v) => !b.data.includes(v));
      if (miss.length) return { ok: false, why: `データが違う(${miss.join(",")} が無い)` };
      const f = b.five;
      if (f.min !== 12 || f.max !== 35 || f.med !== 22) {
        return { ok: false, why: `五数要約が min=${f.min} med=${f.med} max=${f.max}` };
      }
      return { ok: true, why: `min12 Q1${f.q1} med22 Q3${f.q3} max35(データから計算)` };
    },
  },
  {
    id: "scatter",
    unit: "数I データの分析",
    tag: "散布図",
    prompt: "次の5人の身長xと体重yの散布図をかいて。(160,50) (165,55) (170,62) (175,68) (180,75)",
    check(r) {
      const s = r.draws.find((d) => d.t === "scatter");
      if (!s) return { ok: false, why: "散布図が無い" };
      if (s.ps.length !== 5) return { ok: false, why: `点が ${s.ps.length} 個(5個のはず)` };
      const want = [
        [160, 50],
        [165, 55],
        [170, 62],
        [175, 68],
        [180, 75],
      ];
      const miss = want.filter(([x, y]) => !s.ps.some((p) => p[0] === x && p[1] === y));
      if (miss.length) return { ok: false, why: `${miss.map((m) => `(${m})`).join("")} が無い` };
      if (s.r < 0.98) return { ok: false, why: `相関係数 ${s.r.toFixed(3)}(強い正の相関のはず)` };
      return { ok: true, why: `5点、相関係数 r = ${s.r.toFixed(4)}(こちらで計算)` };
    },
  },
  {
    id: "tree",
    unit: "数A 場合の数",
    tag: "樹形図",
    prompt: "コインを3回投げるときの表裏の出方を樹形図でかいて。",
    check(r) {
      const t = r.draws.find((d) => d.t === "tree");
      if (!t) return { ok: false, why: "樹形図が無い" };
      if (t.levels.length !== 3) return { ok: false, why: `段が ${t.levels.length}(3段のはず)` };
      if (t.leaves !== 8) return { ok: false, why: `葉が ${t.leaves} 個(2³=8のはず)` };
      return { ok: true, why: "3段・葉8個(2³)" };
    },
  },
  {
    id: "venn",
    unit: "数A 集合",
    tag: "ベン図",
    prompt:
      "40人のクラスで、数学が好きな人が22人、英語が好きな人が18人、両方好きな人が10人いる。これをベン図で表して。",
    check(r) {
      const v = r.draws.find((d) => d.t === "venn");
      if (!v) return { ok: false, why: "ベン図が無い" };
      if (v.sets.length !== 2) return { ok: false, why: `集合が ${v.sets.length} 個(2個のはず)` };
      const c = v.counts;
      const get = (re) => {
        const k = Object.keys(c).find((x) => re.test(x));
        return k ? c[k] : undefined;
      };
      if (v.total !== 40) return { ok: false, why: `合計が ${v.total} 人(40人のはず)` };
      const both = Object.values(c).find((n) => n === 10);
      if (both === undefined) return { ok: false, why: "共通部分の10人が無い" };
      const only = Object.values(c)
        .sort((a, b) => a - b)
        .join(",");
      if (only !== "8,10,10,12") return { ok: false, why: `内訳が [${only}](12,10,8,10 のはず)` };
      return { ok: true, why: "12/10/8/10 = 40人" };
    },
  },
  {
    id: "lattice",
    unit: "数B 数列 / 数A 整数",
    tag: "格子点",
    prompt: "x ≧ 0, y ≧ 0, x + y ≦ 4 を満たす格子点(x, yがともに整数の点)を図示して。",
    check(r) {
      const l = r.draws.find((d) => d.t === "lattice");
      if (!l) return { ok: false, why: "格子点が無い" };
      // 0<=x, 0<=y, x+y<=4 の格子点は 15 個
      if (l.count !== 15) return { ok: false, why: `格子点が ${l.count} 個(15個のはず)` };
      const bad = l.ps.filter((p) => p.x < 0 || p.y < 0 || p.x + p.y > 4);
      if (bad.length) return { ok: false, why: "条件を外れた点が混ざっている" };
      return { ok: true, why: "15個、すべて x+y≦4 を満たす" };
    },
  },
  {
    id: "normal",
    unit: "数B 統計的な推測",
    tag: "正規分布",
    prompt: "平均50、標準偏差10の正規分布において、40以上60以下となる確率を図で示して。",
    check(r) {
      const n = r.draws.find((d) => d.t === "normal");
      if (!n) return { ok: false, why: "正規分布の図が無い" };
      if (n.mu !== 50 || n.sigma !== 10)
        return { ok: false, why: `μ=${n.mu}, σ=${n.sigma}(50, 10 のはず)` };
      if (!n.shade) return { ok: false, why: "斜線部が無い" };
      if (Math.abs(n.area - 0.6827) > 0.005)
        return { ok: false, why: `斜線部の確率 ${n.area?.toFixed(4)}(0.6827 のはず)` };
      return { ok: true, why: `μ±σ、面積 ${n.area.toFixed(4)}(こちらで積分)` };
    },
  },
  {
    id: "conic",
    unit: "数C 2次曲線",
    tag: "双曲線",
    prompt: "双曲線 x²/9 - y²/16 = 1 の概形を、焦点と漸近線がわかるように図示して。",
    check(r) {
      const c = r.draws.find((d) => d.t === "conic");
      if (!c) return { ok: false, why: "2次曲線が無い(conic を使っていない)" };
      if (c.kind !== "hyperbola") return { ok: false, why: `${c.kind} になっている(双曲線のはず)` };
      if (c.a !== 3 || c.b !== 4) return { ok: false, why: `a=${c.a}, b=${c.b}(3, 4 のはず)` };
      if (Math.abs(c.c - 5) > 1e-9) return { ok: false, why: `焦点が ±${c.c}(±5 のはず)` };
      if (Math.abs(c.asymptotes[0] - 4 / 3) > 1e-9)
        return { ok: false, why: `漸近線の傾きが ${c.asymptotes[0]}` };
      return { ok: true, why: "焦点(±5,0)・漸近線 y=±(4/3)x(c²=a²+b² から計算)" };
    },
  },
  {
    id: "complex",
    unit: "数C 複素数平面",
    tag: "複素数平面",
    prompt: "複素数平面上の点 A(2+i) を原点のまわりに90°回転した点Bを図示して。",
    check(r) {
      const cp = r.draws.find((d) => d.t === "complexPlane");
      if (!cp) return { ok: false, why: "複素数平面が無い" };
      const { A, B } = r.pts;
      if (!A) return { ok: false, why: "A が無い" };
      if (Math.abs(A.x - 2) > 1e-9 || Math.abs(A.y - 1) > 1e-9)
        return { ok: false, why: `A が (${A.x},${A.y})(2+i のはず)` };
      if (!B) return { ok: false, why: "回転した点 B が無い" };
      // (2+i)*i = -1+2i
      if (Math.abs(B.x + 1) > 1e-9 || Math.abs(B.y - 2) > 1e-9) {
        return { ok: false, why: `B が (${B.x.toFixed(2)},${B.y.toFixed(2)})(-1+2i のはず)` };
      }
      return { ok: true, why: "A(2,1) → B(-1,2)(90°回転をこちらで計算)" };
    },
  },
  {
    id: "concave",
    unit: "数III 微分法",
    tag: "凹凸つき増減表",
    prompt: "y = x³ - 3x² の増減表を、凹凸(変曲点)まで含めてかいて。",
    check(r) {
      const t = r.draws.find((d) => d.t === "signTable");
      if (!t) return { ok: false, why: "増減表が無い" };
      if (!t.inflect) return { ok: false, why: "凹凸(変曲点)が入っていない" };
      if (t.crit.length !== 2 || Math.abs(t.crit[0]) > 1e-9 || Math.abs(t.crit[1] - 2) > 1e-9) {
        return { ok: false, why: `極値の x が [${t.crit}](0, 2 のはず)` };
      }
      if (t.inflect.length !== 1 || Math.abs(t.inflect[0] - 1) > 1e-9) {
        return { ok: false, why: `変曲点が [${t.inflect}](1 のはず)` };
      }
      if (t.concave.join("/") !== "上に凸/下に凸")
        return { ok: false, why: `凹凸が ${t.concave.join("/")}` };
      return { ok: true, why: "極値 x=0,2 / 変曲点 x=1 / 上に凸→下に凸" };
    },
  },
  {
    id: "riemann",
    unit: "数III 積分法",
    tag: "区分求積",
    prompt:
      "y = x² と x軸、x = 1 で囲まれた部分の面積を、区分求積法(短冊を4本)の考え方で図示して。",
    check(r) {
      const rm = r.draws.find((d) => d.t === "riemann");
      if (!rm) return { ok: false, why: "短冊が無い(riemann を使っていない)" };
      if (rm.n !== 4) return { ok: false, why: `短冊が ${rm.n} 本(4本のはず)` };
      if (Math.abs(rm.width - 0.25) > 1e-9)
        return { ok: false, why: `幅が ${rm.width}(0.25 のはず)` };
      // 左端なら 7/32=0.21875、右端なら 15/32=0.46875。どちらでもよいが 1/3 の周りに来ること
      if (rm.sum < 0.15 || rm.sum > 0.55)
        return { ok: false, why: `面積の和が ${rm.sum.toFixed(4)}(1/3 の近くのはず)` };
      return { ok: true, why: `4本・幅0.25・和 ${rm.sum.toFixed(5)}(∫=0.3333)` };
    },
  },
  {
    id: "bisect",
    unit: "数A 図形の性質",
    tag: "角の二等分線",
    prompt:
      "三角形ABCの∠Aの二等分線と辺BCの交点をDとする。AB=6, AC=4 のとき、BD:DC を説明する図をかいて。",
    check(r) {
      const { A, B, C, D } = r.pts;
      if (!A || !B || !C || !D) return { ok: false, why: "A,B,C,D が足りない" };
      const ab = Math.hypot(A.x - B.x, A.y - B.y);
      const ac = Math.hypot(A.x - C.x, A.y - C.y);
      if (Math.abs(ab - 6) > 0.01 || Math.abs(ac - 4) > 0.01) {
        return { ok: false, why: `AB=${ab.toFixed(2)}, AC=${ac.toFixed(2)}(6, 4 のはず)` };
      }
      const cross = Math.abs((C.x - B.x) * (D.y - B.y) - (C.y - B.y) * (D.x - B.x));
      if (cross > 1e-6) return { ok: false, why: "D が BC 上にない" };
      // 角の二等分線なら BD:DC = AB:AC = 3:2 に**なるはず**(指定していないのに、そうなる)
      const k = Math.hypot(B.x - D.x, B.y - D.y) / Math.hypot(D.x - C.x, D.y - C.y);
      if (Math.abs(k - 1.5) > 1e-4)
        return { ok: false, why: `BD:DC = ${k.toFixed(4)}:1(1.5:1 のはず)` };
      return { ok: true, why: `AB:AC=6:4、BD:DC=${k.toFixed(4)}:1 が作図の結果として出た` };
    },
  },
  {
    id: "asymptote",
    unit: "数II 指数対数 / 数III 極限",
    tag: "漸近線",
    prompt: "y = 1/(x-2) + 1 のグラフを、漸近線がわかるように図示して。",
    check(r) {
      const as = r.draws.filter((d) => d.t === "asymptote");
      if (as.length < 2) return { ok: false, why: `漸近線が ${as.length} 本(縦横2本ほしい)` };
      const vx = as.find((a) => a.x !== undefined);
      const hy = as.find((a) => a.y !== undefined);
      if (!vx || Math.abs(vx.x - 2) > 1e-9)
        return { ok: false, why: `縦の漸近線が x=${vx?.x}(x=2 のはず)` };
      if (!hy || Math.abs(hy.y - 1) > 1e-9)
        return { ok: false, why: `横の漸近線が y=${hy?.y}(y=1 のはず)` };
      if (!r.draws.some((d) => d.t === "curve")) return { ok: false, why: "グラフが無い" };
      return { ok: true, why: "x=2 と y=1" };
    },
  },

  // ---- 「重ね合わせで書けるか」を試すだけの8問 ----
  // **ここには新しい語彙を1つも足していない。**いまある語彙の組み合わせだけで
  // 届くのか、それとも語彙が要るのかを、こちらの予想抜きで測る。
  {
    id: "tetra",
    unit: "数A 空間図形",
    tag: "正四面体",
    probe: true,
    prompt: "正四面体ABCDの見取図をかいて。",
    check(r) {
      const names = ["A", "B", "C", "D"].filter((n) => r.pts[n]);
      if (names.length < 4) return { ok: false, why: `頂点が ${names.length} 個` };
      const segs = r.draws.filter((d) => d.t === "seg" && d.names);
      const pairs = new Set(segs.map((s) => [...s.names].sort().join("")));
      const want = ["AB", "AC", "AD", "BC", "BD", "CD"];
      const miss = want.filter((w) => !pairs.has(w));
      if (miss.length) return { ok: false, why: `辺が足りない: ${miss.join(",")}` };
      if (!segs.some((s) => s.dash)) return { ok: false, why: "隠れ線(破線)が無い" };
      return { ok: true, why: "4頂点・6辺・隠れ線あり" };
    },
  },
  {
    id: "cone",
    unit: "数A / 数III",
    tag: "円錐",
    probe: true,
    prompt: "底面の半径2、高さ4の円錐の見取図をかいて。",
    check(r) {
      const top = r.draws.find((d) => d.revolveTop);
      if (!top) return { ok: false, why: "回転体になっていない" };
      const caps = r.draws.filter((d) => d.cap);
      if (!caps.length) return { ok: false, why: "底面の円が無い" };
      const rad = Math.max(...caps.map((c) => Math.max(c.rx, c.ry)));
      if (Math.abs(rad - 2) > 0.05)
        return { ok: false, why: `底面の半径が ${rad.toFixed(2)}(2 のはず)` };
      const xs = top.ps.map((p) => p.x);
      const h = Math.max(...xs) - Math.min(...xs);
      if (Math.abs(h - 4) > 0.05) return { ok: false, why: `高さが ${h.toFixed(2)}(4 のはず)` };
      // 母線が直線か(円錐なら輪郭は直線)
      const a = top.ps[0];
      const b = top.ps[top.ps.length - 1];
      const m = top.ps[Math.floor(top.ps.length / 2)];
      const dev =
        Math.abs((b.x - a.x) * (m.y - a.y) - (b.y - a.y) * (m.x - a.x)) /
        Math.hypot(b.x - a.x, b.y - a.y);
      if (dev > 0.03) return { ok: false, why: `輪郭が直線でない(ずれ ${dev.toFixed(3)})` };
      return { ok: true, why: "半径2・高さ4・輪郭は直線" };
    },
  },
  {
    id: "cut",
    unit: "数A 図形の性質",
    tag: "立体の切断面",
    probe: true,
    prompt: "直方体ABCD-EFGHを、辺AB、BC、BFのそれぞれの中点を通る平面で切る。切り口を図示して。",
    check(r) {
      const box = r.draws.find((d) => d.t === "box3");
      if (!box) return { ok: false, why: "直方体が無い" };
      const poly = r.draws.filter((d) => d.t === "poly" && d.ps.length === 3);
      if (!poly.length) return { ok: false, why: "三角形の切り口が無い" };
      // 切り口の頂点が、直方体の辺の上に乗っているか
      const vs = box.labels.map((n) => r.pts[n]);
      const onEdge = (p) =>
        vs.some((u) =>
          vs.some((v) => {
            if (u === v) return false;
            const cr = Math.abs((v.x - u.x) * (p.y - u.y) - (v.y - u.y) * (p.x - u.x));
            const len = Math.hypot(v.x - u.x, v.y - u.y) || 1;
            const t = ((p.x - u.x) * (v.x - u.x) + (p.y - u.y) * (v.y - u.y)) / (len * len);
            return cr / len < 0.05 && t > 0.02 && t < 0.98;
          }),
        );
      const bad = poly[0].ps.filter((p) => !onEdge(p));
      if (bad.length) return { ok: false, why: `切り口の頂点 ${bad.length} 個が辺の上にない` };
      return { ok: true, why: "切り口の3頂点すべてが辺の上" };
    },
  },
  {
    id: "vecsum",
    unit: "数C ベクトル",
    tag: "ベクトルの和(平行四辺形)",
    probe: true,
    prompt: "2つのベクトル a と b の和を、平行四辺形をつくって図示して。",
    check(r) {
      const vs = r.draws.filter((d) => d.t === "vec");
      if (vs.length < 3) return { ok: false, why: `矢印が ${vs.length} 本(a, b, a+b で3本ほしい)` };
      // 同じ始点から出る3本を探し、1本が他の2本の和になっているか
      for (const o of vs) {
        const same = vs.filter((v) => Math.hypot(v.a.x - o.a.x, v.a.y - o.a.y) < 1e-6);
        if (same.length < 3) continue;
        for (const s of same) {
          const rest = same.filter((v) => v !== s);
          for (let i = 0; i < rest.length; i++)
            for (let j = i + 1; j < rest.length; j++) {
              const sx = rest[i].b.x - o.a.x + (rest[j].b.x - o.a.x) + o.a.x;
              const sy = rest[i].b.y - o.a.y + (rest[j].b.y - o.a.y) + o.a.y;
              if (Math.hypot(s.b.x - sx, s.b.y - sy) < 1e-6) {
                return {
                  ok: true,
                  why: `${s.names.join("")} = ${rest[i].names.join("")} + ${rest[j].names.join("")}`,
                };
              }
            }
        }
      }
      return { ok: false, why: "和になっている矢印が無い(平行四辺形が閉じていない)" };
    },
  },
  {
    id: "proj",
    unit: "数C ベクトル",
    tag: "正射影(内積)",
    probe: true,
    prompt: "ベクトルOAからベクトルOBへ下ろした垂線の足をHとする。正射影を説明する図をかいて。",
    check(r) {
      const { O, A, B, H } = r.pts;
      if (!O || !A || !B || !H) return { ok: false, why: "O,A,B,H が足りない" };
      // H が直線 OB 上にあるか
      const cr = Math.abs((B.x - O.x) * (H.y - O.y) - (B.y - O.y) * (H.x - O.x));
      if (cr / (Math.hypot(B.x - O.x, B.y - O.y) || 1) > 1e-4)
        return { ok: false, why: "H が OB 上にない" };
      // AH ⊥ OB か
      const dot = (A.x - H.x) * (B.x - O.x) + (A.y - H.y) * (B.y - O.y);
      const n = Math.hypot(A.x - H.x, A.y - H.y) * Math.hypot(B.x - O.x, B.y - O.y);
      if (Math.abs(dot / (n || 1)) > 1e-4)
        return { ok: false, why: `AH が OB に垂直でない(cos=${(dot / n).toFixed(3)})` };
      return { ok: true, why: "H は OB 上、AH ⊥ OB" };
    },
  },
  {
    id: "inverse",
    unit: "数III 逆関数",
    tag: "逆関数(y=x 対称)",
    probe: true,
    prompt:
      "y = e^x と、その逆関数 y = log x のグラフが直線 y = x について対称であることを図示して。",
    check(r) {
      const cs = r.draws.filter((d) => d.t === "curve");
      if (cs.length < 3)
        return { ok: false, why: `曲線・直線が ${cs.length} 本(2曲線 + y=x で3本ほしい)` };
      // y=x を1本見つける
      const diag = cs.find((c) => c.ps.every((p) => Math.abs(p.x - p.y) < 1e-6));
      if (!diag) return { ok: false, why: "y = x が無い" };
      const others = cs.filter((c) => c !== diag);
      // 片方の点を (x,y)->(y,x) にしたとき、もう片方に乗るか
      for (const u of others)
        for (const v of others) {
          if (u === v) continue;
          const hit = u.ps.filter((p) =>
            v.ps.some((q) => Math.hypot(q.x - p.y, q.y - p.x) < 0.06),
          ).length;
          if (hit > u.ps.length * 0.5)
            return { ok: true, why: `2曲線が y=x について対称(${hit}/${u.ps.length} 点で一致)` };
        }
      return { ok: false, why: "2曲線が y=x について対称になっていない" };
    },
  },
  {
    id: "piechart",
    unit: "データ",
    tag: "円グラフ",
    probe: true,
    prompt: "好きな教科のアンケート結果(数学40%、英語30%、国語20%、その他10%)を円グラフで表して。",
    check(r) {
      // 扇形が4つ、中心角が 144/108/72/36 度になっているか
      const wedges = r.draws.filter((d) => d.t === "poly" && d.fill);
      const arcs = r.draws.filter((d) => d.t === "arc");
      if (wedges.length < 4 && arcs.length < 4) {
        return { ok: false, why: `扇形が ${Math.max(wedges.length, arcs.length)} 個(4個ほしい)` };
      }
      const want = [144, 108, 72, 36];
      const got = arcs
        .map((a) => {
          const t1 = Math.atan2(a.a.y - a.o.y, a.a.x - a.o.x);
          const t2 = Math.atan2(a.b.y - a.o.y, a.b.x - a.o.x);
          return Math.abs((((t2 - t1) * 180) / Math.PI + 360) % 360);
        })
        .sort((x, y) => y - x);
      if (got.length < 4) return { ok: false, why: "中心角を測れる扇形が4つ無い" };
      const bad = want.filter((w, i) => Math.abs(got[i] - w) > 1);
      if (bad.length)
        return {
          ok: false,
          why: `中心角が ${got
            .slice(0, 4)
            .map((v) => v.toFixed(0))
            .join("/")}(144/108/72/36 のはず)`,
        };
      return { ok: true, why: "中心角 144/108/72/36" };
    },
  },
  {
    id: "linechart",
    unit: "データ",
    tag: "折れ線グラフ",
    probe: true,
    prompt: "ある店の月別売上(1月10, 2月14, 3月12, 4月18, 5月16)を折れ線グラフで表して。",
    check(r) {
      const want = [
        [1, 10],
        [2, 14],
        [3, 12],
        [4, 18],
        [5, 16],
      ];
      const pts = Object.values(r.pts);
      const miss = want.filter(
        ([x, y]) => !pts.some((p) => Math.abs(p.x - x) < 0.01 && Math.abs(p.y - y) < 0.01),
      );
      if (miss.length) return { ok: false, why: `${miss.map((m) => `(${m})`).join("")} が無い` };
      const segs = r.draws.filter((d) => d.t === "seg");
      const linked = want.slice(0, -1).filter(([x, y], i) => {
        const [x2, y2] = want[i + 1];
        return segs.some(
          (s) =>
            (Math.abs(s.a.x - x) < 0.01 &&
              Math.abs(s.a.y - y) < 0.01 &&
              Math.abs(s.b.x - x2) < 0.01 &&
              Math.abs(s.b.y - y2) < 0.01) ||
            (Math.abs(s.b.x - x) < 0.01 &&
              Math.abs(s.b.y - y) < 0.01 &&
              Math.abs(s.a.x - x2) < 0.01 &&
              Math.abs(s.a.y - y2) < 0.01),
        );
      }).length;
      if (linked < 4) return { ok: false, why: `隣どうしを結ぶ線が ${linked}/4 本` };
      return { ok: true, why: "5点・隣どうしを結ぶ線4本" };
    },
  },
];
