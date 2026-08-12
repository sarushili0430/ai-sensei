// solve() の結果 → SVG。**黒板に描いた見え方**をそのまま出す。
//
// これは同時に、D-19/D-20 で勧めた「サーバで解いて SVG を送る」経路の実物。
// Flutter 側は SVG を描くだけになるので、語彙が増えても端末側は1行も増えない。

const BOARD = "#2f3a35";
const CHALK = "#edeae0";
const DIM = "#a8ada4";
const ROLE = {
  key: { c: "#f2d675", w: 2.4 },
  a: { c: "#f0a3ab", w: 2.2 },
  b: { c: "#9cc7e8", w: 2.2 },
  aux: { c: DIM, w: 1.3, dash: "5 4" },
};
const role = (as) => ROLE[as] || { c: CHALK, w: 1.8 };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f = (v) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 100) / 100);

const W = 320;
const H = 224;

function frame(inner, w = W, h = H) {
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" role="img"><rect width="${w}" height="${h}" fill="${BOARD}"/><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${CHALK}"/></marker><marker id="ahk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${ROLE.key.c}"/></marker></defs>${inner}</svg>`;
}
const txt = (x, y, s, o = {}) =>
  `<text x="${f(x)}" y="${f(y)}" fill="${o.fill || CHALK}" font-size="${o.size || 11}" ` +
  `font-family="ui-sans-serif,system-ui,sans-serif" text-anchor="${o.anchor || "middle"}"` +
  `${o.weight ? ` font-weight="${o.weight}"` : ""}>${esc(s)}</text>`;
const line = (x1, y1, x2, y2, o = {}) =>
  `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${o.c || CHALK}" ` +
  `stroke-width="${o.w || 1.6}" stroke-linecap="round"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}` +
  `${o.marker ? ` marker-end="url(#${o.marker})"` : ""}/>`;

// ---- 幾何(座標を持つもの)は、まとめて枠に収める ----
function geometric(draws) {
  const xs = [];
  const ys = [];
  // **軸が宣言されていれば、それを枠の正とする。**
  // y=1/(x-2) のように極を持つ曲線は min/max が発散し、
  // 素直に全点を囲むと図が1本の線に潰れる(実際そうなった)。
  const ax = draws.find((d) => d.t === "axes");
  const clip = ax ? { x0: ax.span[0], x1: ax.span[1], y0: ax.span[2], y1: ax.span[3] } : null;
  const inClip = (p) =>
    !clip ||
    (p.x >= clip.x0 - 1e-9 &&
      p.x <= clip.x1 + 1e-9 &&
      p.y >= clip.y0 - 1e-9 &&
      p.y <= clip.y1 + 1e-9);
  const eat = (p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (!inClip(p)) return;
    xs.push(p.x);
    ys.push(p.y);
  };
  for (const d of draws) {
    eat(d.p);
    eat(d.a);
    eat(d.b);
    eat(d.o);
    eat(d.c);
    // **散布図の点は `[x, y]` の配列なので、`{x,y}` だけ見ていると枠に入らない。**
    // 最初これで点が画面の外に飛び、`r = 0.999` だけが出ている絵になった。
    if (d.t === "scatter") d.ps.forEach((p) => eat({ x: p[0], y: p[1] }));
    else (d.ps || []).forEach(eat);
    (d.cells || []).forEach(eat);
    if (d.t === "complexPlane") {
      xs.push(-d.span, d.span);
      ys.push(-d.span, d.span);
    }
    if (d.t === "circle") {
      xs.push(d.c.x - d.r, d.c.x + d.r);
      ys.push(d.c.y - d.r, d.c.y + d.r);
    }
    if (d.t === "ellipse") {
      xs.push(d.c.x - d.rx, d.c.x + d.rx);
      ys.push(d.c.y - d.ry, d.c.y + d.ry);
    }
    if (d.t === "axes") {
      xs.push(d.span[0], d.span[1]);
      ys.push(d.span[2], d.span[3]);
    }
    if (d.t === "unitCircle") {
      xs.push(-1.25, 1.25);
      ys.push(-1.25, 1.25);
    }
    if (d.t === "conic") {
      const r = d.kind === "parabola" ? d.a * 4 : d.c * 1.3;
      xs.push(-r, r);
      ys.push(-r * 0.75, r * 0.75);
    }
    if (d.t === "riemann")
      d.bars.forEach((x) => {
        xs.push(x.from, x.to);
        ys.push(0, x.h);
      });
    if (d.t === "asymptote") {
      if (d.x !== undefined) xs.push(d.x);
      if (d.y !== undefined) ys.push(d.y);
    }
  }
  if (!xs.length) {
    xs.push(-1, 1);
    ys.push(-1, 1);
  }
  const pad = 26;
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (x1 - x0 < 1e-9) {
    x0 -= 1;
    x1 += 1;
  }
  if (y1 - y0 < 1e-9) {
    y0 -= 1;
    y1 += 1;
  }
  const k = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const X = (x) => W / 2 + (x - cx) * k;
  const Y = (y) => H / 2 - (y - cy) * k; // y は上向き
  const out = [];

  for (const d of draws) {
    const r = role(d.as);
    const dash = d.dash ? "5 4" : r.dash;
    switch (d.t) {
      case "region":
        // 塗りは点の集まりで表す(黒板のハッチのように見せる)
        out.push(
          `<g fill="${role(d.as).c}" opacity="0.5">${d.cells
            .filter((_, i) => i % 3 === 0)
            .map((p) => `<circle cx="${f(X(p.x))}" cy="${f(Y(p.y))}" r="1.5"/>`)
            .join("")}</g>`,
        );
        break;
      case "axes": {
        const [ax0, ax1, ay0, ay1] = d.span;
        out.push(line(X(ax0), Y(0), X(ax1), Y(0), { c: DIM, w: 1.2, marker: "ah" }));
        out.push(line(X(0), Y(ay0), X(0), Y(ay1), { c: DIM, w: 1.2, marker: "ah" }));
        out.push(txt(X(ax1) - 6, Y(0) + 13, "x", { fill: DIM, size: 10 }));
        out.push(txt(X(0) - 10, Y(ay1) + 10, "y", { fill: DIM, size: 10 }));
        (d.ticks || []).forEach((t) => {
          out.push(line(X(t), Y(0) - 3, X(t), Y(0) + 3, { c: DIM, w: 1.2 }));
          out.push(txt(X(t), Y(0) + 14, t, { fill: DIM, size: 9 }));
        });
        break;
      }
      case "asymptote":
        if (d.x !== undefined)
          out.push(line(X(d.x), 8, X(d.x), H - 8, { c: DIM, w: 1.3, dash: "5 4" }));
        else if (d.y !== undefined)
          out.push(line(8, Y(d.y), W - 8, Y(d.y), { c: DIM, w: 1.3, dash: "5 4" }));
        break;
      case "circle":
        out.push(
          `<circle cx="${f(X(d.c.x))}" cy="${f(Y(d.c.y))}" r="${f(d.r * k)}" fill="none" stroke="${r.c}" stroke-width="${r.w}"/>`,
        );
        break;
      case "ellipse":
        out.push(
          `<ellipse cx="${f(X(d.c.x))}" cy="${f(Y(d.c.y))}" rx="${f(d.rx * k)}" ry="${f(d.ry * k)}" fill="none" stroke="${r.c}" stroke-width="${r.w}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
        );
        break;
      case "seg":
        out.push(line(X(d.a.x), Y(d.a.y), X(d.b.x), Y(d.b.y), { c: r.c, w: r.w, dash }));
        if (d.label || d.part !== undefined) {
          const mx = (X(d.a.x) + X(d.b.x)) / 2;
          const my = (Y(d.a.y) + Y(d.b.y)) / 2;
          out.push(txt(mx, my - 5, d.label ?? d.part, { fill: r.c, size: 10 }));
        }
        break;
      case "vec":
        out.push(
          line(X(d.a.x), Y(d.a.y), X(d.b.x), Y(d.b.y), {
            c: r.c,
            w: r.w,
            marker: d.as === "key" ? "ahk" : "ah",
          }),
        );
        if (d.label) {
          const mx = (X(d.a.x) + X(d.b.x)) / 2;
          const my = (Y(d.a.y) + Y(d.b.y)) / 2;
          out.push(txt(mx + 8, my - 4, d.label, { fill: r.c, size: 10 }));
        }
        break;
      case "poly": {
        const pts = d.ps.map((p) => `${f(X(p.x))},${f(Y(p.y))}`).join(" ");
        out.push(
          `<polygon points="${pts}" fill="${d.fill ? r.c : "none"}" fill-opacity="${d.fill ? 0.28 : 0}" stroke="${r.c}" stroke-width="${r.w}"/>`,
        );
        break;
      }
      case "curve": {
        // 枠の外へ出た点で線を切る。極をまたいで一直線に結ばない。
        const segs = [];
        let cur = [];
        for (const p of d.ps) {
          if (inClip(p)) cur.push(`${f(X(p.x))},${f(Y(p.y))}`);
          else {
            if (cur.length > 1) segs.push(cur);
            cur = [];
          }
        }
        if (cur.length > 1) segs.push(cur);
        for (const s of segs) {
          out.push(
            `<polyline points="${s.join(" ")}" fill="none" stroke="${r.c}" stroke-width="${r.w}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
          );
        }
        break;
      }
      case "riemann":
        d.bars.forEach((bar) => {
          const y0b = Y(0);
          const y1b = Y(bar.h);
          out.push(
            `<rect x="${f(X(bar.from))}" y="${f(Math.min(y0b, y1b))}" width="${f((bar.to - bar.from) * k)}" ` +
              `height="${f(Math.abs(y1b - y0b))}" fill="${ROLE.key.c}" fill-opacity="0.22" stroke="${ROLE.key.c}" stroke-width="1"/>`,
          );
        });
        break;
      case "conic": {
        const A = d.a * k;
        const B = (d.b || d.a) * k;
        const ox = X(0);
        const oy = Y(0);
        if (d.kind === "ellipse") {
          out.push(
            `<ellipse cx="${f(ox)}" cy="${f(oy)}" rx="${f(A)}" ry="${f(B)}" fill="none" stroke="${CHALK}" stroke-width="1.8"/>`,
          );
        } else if (d.kind === "hyperbola") {
          for (const s of [1, -1]) {
            const pts = [];
            for (let i = 0; i <= 40; i++) {
              const t = -1.4 + (2.8 * i) / 40;
              pts.push(`${f(ox + s * A * Math.cosh(t))},${f(oy - B * Math.sinh(t))}`);
            }
            out.push(
              `<polyline points="${pts.join(" ")}" fill="none" stroke="${CHALK}" stroke-width="1.8"/>`,
            );
          }
          d.asymptotes.forEach((m) => {
            const L = d.c * 1.25;
            out.push(
              line(ox - L * k, oy + m * L * k, ox + L * k, oy - m * L * k, {
                c: DIM,
                w: 1.2,
                dash: "5 4",
              }),
            );
          });
        } else {
          const pts = [];
          for (let i = 0; i <= 40; i++) {
            const y = -2 * d.a + (4 * d.a * i) / 40;
            pts.push(`${f(ox + ((y * y) / (4 * d.a)) * k)},${f(oy - y * k)}`);
          }
          out.push(
            `<polyline points="${pts.join(" ")}" fill="none" stroke="${CHALK}" stroke-width="1.8"/>`,
          );
          out.push(
            line(X(d.directrix), 10, X(d.directrix), H - 10, { c: DIM, w: 1.2, dash: "5 4" }),
          );
          out.push(txt(X(d.directrix), 16, "準線", { fill: DIM, size: 9 }));
        }
        (d.foci || []).forEach((p, i) => {
          out.push(`<circle cx="${f(X(p.x))}" cy="${f(Y(p.y))}" r="3" fill="${ROLE.key.c}"/>`);
          out.push(txt(X(p.x), Y(p.y) - 7, `F${i + 1}`, { fill: ROLE.key.c, size: 9 }));
        });
        break;
      }
      case "unitCircle":
        out.push(
          `<circle cx="${f(X(0))}" cy="${f(Y(0))}" r="${f(k)}" fill="none" stroke="${CHALK}" stroke-width="1.8"/>`,
        );
        out.push(line(X(-1.2), Y(0), X(1.2), Y(0), { c: DIM, w: 1.1 }));
        out.push(line(X(0), Y(-1.2), X(0), Y(1.2), { c: DIM, w: 1.1 }));
        d.marks.forEach((m) => {
          out.push(line(X(0), Y(0), X(m.p.x), Y(m.p.y), { c: ROLE.key.c, w: 1.8 }));
          out.push(`<circle cx="${f(X(m.p.x))}" cy="${f(Y(m.p.y))}" r="3" fill="${ROLE.key.c}"/>`);
          out.push(
            txt(X(m.p.x) + (m.p.x >= 0 ? 22 : -22), Y(m.p.y) - 6, `${m.deg}°`, {
              fill: ROLE.key.c,
              size: 9,
            }),
          );
        });
        break;
      case "complexPlane":
        // 実軸・虚軸を引く。**軸が無いと「複素数平面」に見えない。**
        out.push(line(X(-d.span), Y(0), X(d.span), Y(0), { c: DIM, w: 1.2, marker: "ah" }));
        out.push(line(X(0), Y(-d.span), X(0), Y(d.span), { c: DIM, w: 1.2, marker: "ah" }));
        out.push(txt(X(d.span) - 4, Y(0) + 14, "実軸", { fill: DIM, size: 9 }));
        out.push(txt(X(0) + 18, Y(d.span) + 10, "虚軸", { fill: DIM, size: 9 }));
        break;
      case "lattice":
        d.ps.forEach((p) =>
          out.push(`<circle cx="${f(X(p.x))}" cy="${f(Y(p.y))}" r="2.6" fill="${ROLE.key.c}"/>`),
        );
        out.push(txt(W - 8, H - 8, `${d.count} 個`, { fill: DIM, size: 10, anchor: "end" }));
        break;
      case "scatter":
        d.ps.forEach((p) =>
          out.push(`<circle cx="${f(X(p[0]))}" cy="${f(Y(p[1]))}" r="3.2" fill="${ROLE.b.c}"/>`),
        );
        out.push(
          txt(W - 8, 16, `r = ${d.r.toFixed(3)}`, { fill: ROLE.key.c, size: 10, anchor: "end" }),
        );
        break;
      case "arc": {
        const ra = 20;
        const a1 = Math.atan2(Y(d.a.y) - Y(d.o.y), X(d.a.x) - X(d.o.x));
        const a2 = Math.atan2(Y(d.b.y) - Y(d.o.y), X(d.b.x) - X(d.o.x));
        const sweep = (a2 - a1 + Math.PI * 3) % (Math.PI * 2) > Math.PI ? 0 : 1;
        out.push(
          `<path d="M ${f(X(d.o.x) + ra * Math.cos(a1))} ${f(Y(d.o.y) + ra * Math.sin(a1))} ` +
            `A ${ra} ${ra} 0 0 ${sweep} ${f(X(d.o.x) + ra * Math.cos(a2))} ${f(Y(d.o.y) + ra * Math.sin(a2))}" ` +
            `fill="none" stroke="${ROLE.key.c}" stroke-width="1.4"/>`,
        );
        if (d.label) {
          const am =
            a1 +
            ((a2 - a1 + Math.PI * 3) % (Math.PI * 2) > Math.PI ? a2 - a1 - Math.PI * 2 : a2 - a1) /
              2;
          out.push(
            txt(
              X(d.o.x) + (ra + 12) * Math.cos(am),
              Y(d.o.y) + (ra + 12) * Math.sin(am) + 3,
              d.label,
              { fill: ROLE.key.c, size: 9 },
            ),
          );
        }
        break;
      }
      case "right": {
        const s = 9;
        const u = unit(X(d.a.x) - X(d.o.x), Y(d.a.y) - Y(d.o.y));
        const v = unit(X(d.b.x) - X(d.o.x), Y(d.b.y) - Y(d.o.y));
        out.push(
          `<polyline points="${f(X(d.o.x) + u.x * s)},${f(Y(d.o.y) + u.y * s)} ` +
            `${f(X(d.o.x) + (u.x + v.x) * s)},${f(Y(d.o.y) + (u.y + v.y) * s)} ` +
            `${f(X(d.o.x) + v.x * s)},${f(Y(d.o.y) + v.y * s)}" fill="none" stroke="${ROLE.key.c}" stroke-width="1.3"/>`,
        );
        break;
      }
      case "mark":
        out.push(
          `<circle cx="${f(X(d.p.x))}" cy="${f(Y(d.p.y))}" r="5.5" fill="none" stroke="${role(d.as).c}" stroke-width="1.6"/>`,
        );
        break;
      case "pt":
        out.push(
          `<circle cx="${f(X(d.p.x))}" cy="${f(Y(d.p.y))}" r="${d.small ? 2.2 : 2.8}" fill="${CHALK}"/>`,
        );
        // **名前と座標を別々の行に出すと、点が集まったところで必ず重なる。**
        // 座標を出すときは1つのラベルにまとめる。
        if (d.coord) {
          out.push(
            txt(X(d.p.x), Y(d.p.y) - 8, `${d.name ?? ""}${d.coord}`, {
              fill: ROLE.key.c,
              size: 9,
              weight: 600,
            }),
          );
        } else if (d.name) {
          out.push(txt(X(d.p.x), Y(d.p.y) - 7, d.name, { size: d.small ? 9 : 10, weight: 600 }));
        }
        break;
      default:
        break;
    }
  }
  return frame(out.join(""));
}
const unit = (x, y) => {
  const n = Math.hypot(x, y) || 1;
  return { x: x / n, y: y / n };
};

// ---- 図表(座標を持たないもの)は、それぞれ専用に置く ----
const SPECIAL = {
  numberLine(d) {
    const [s0, s1] = d.span;
    const pad = 30;
    const y = H / 2;
    const X = (v) => pad + ((v - s0) / (s1 - s0)) * (W - pad * 2);
    const o = [line(pad - 10, y, W - pad + 10, y, { c: DIM, w: 1.4, marker: "ah" })];
    (d.ticks || []).forEach((t) => {
      o.push(line(X(t), y - 4, X(t), y + 4, { c: DIM, w: 1.2 }));
      o.push(txt(X(t), y + 18, t, { fill: DIM, size: 10 }));
    });
    d.ranges.forEach((g) => {
      const a = Math.max(g.from, s0);
      const b = Math.min(g.to, s1);
      const c = role(g.as || "key").c;
      o.push(line(X(a), y - 9, X(b), y - 9, { c, w: 4 }));
      [
        [g.from, g.closedFrom, a],
        [g.to, g.closedTo, b],
      ].forEach(([v, closed, at]) => {
        if (!Number.isFinite(v)) return;
        o.push(
          `<circle cx="${f(X(at))}" cy="${f(y - 9)}" r="4" fill="${closed ? c : BOARD}" stroke="${c}" stroke-width="1.8"/>`,
        );
        o.push(txt(X(at), y - 20, v, { fill: c, size: 10 }));
      });
    });
    return frame(o.join(""));
  },
  boxplot(d) {
    const { min, q1, med, q3, max } = d.five;
    const pad = 34;
    const y = H / 2;
    const lo = min - (max - min) * 0.12;
    const hi = max + (max - min) * 0.12;
    const X = (v) => pad + ((v - lo) / (hi - lo)) * (W - pad * 2);
    const bh = 34;
    const o = [];
    o.push(line(X(min), y, X(q1), y, { c: CHALK, w: 1.5 }));
    o.push(line(X(q3), y, X(max), y, { c: CHALK, w: 1.5 }));
    [min, max].forEach((v) => o.push(line(X(v), y - 10, X(v), y + 10, { c: CHALK, w: 1.5 })));
    o.push(
      `<rect x="${f(X(q1))}" y="${f(y - bh / 2)}" width="${f(X(q3) - X(q1))}" height="${bh}" ` +
        `fill="${ROLE.b.c}" fill-opacity="0.2" stroke="${ROLE.b.c}" stroke-width="1.8"/>`,
    );
    o.push(line(X(med), y - bh / 2, X(med), y + bh / 2, { c: ROLE.key.c, w: 2.6 }));
    [
      ["min", min],
      ["Q1", q1],
      ["中央", med],
      ["Q3", q3],
      ["max", max],
    ].forEach(([nm, v], i) => {
      o.push(
        txt(X(v), y + bh / 2 + 18 + (i % 2 ? 13 : 0), `${nm} ${f(v)}`, {
          fill: i === 2 ? ROLE.key.c : DIM,
          size: 9,
        }),
      );
    });
    o.push(txt(W / 2, 18, "五数要約はデータから計算", { fill: DIM, size: 9 }));
    return frame(o.join(""));
  },
  histogram(d) {
    const pad = 30;
    const base = H - 34;
    const maxN = Math.max(...d.bins.map((b) => b.n)) || 1;
    const bw = (W - pad * 2) / d.bins.length;
    const o = [line(pad, base, W - pad, base, { c: DIM, w: 1.3 })];
    d.bins.forEach((b, i) => {
      const h = (b.n / maxN) * (base - 40);
      o.push(
        `<rect x="${f(pad + i * bw + 2)}" y="${f(base - h)}" width="${f(bw - 4)}" height="${f(h)}" ` +
          `fill="${ROLE.b.c}" fill-opacity="0.28" stroke="${ROLE.b.c}" stroke-width="1.5"/>`,
      );
      o.push(txt(pad + i * bw + bw / 2, base - h - 5, b.n, { fill: ROLE.key.c, size: 10 }));
      o.push(txt(pad + i * bw + bw / 2, base + 13, `${f(b.from)}`, { fill: DIM, size: 8 }));
    });
    o.push(txt(W / 2, 18, "度数はこちらが数える", { fill: DIM, size: 9 }));
    return frame(o.join(""));
  },
  normal(d) {
    const pad = 26;
    const base = H - 34;
    const lo = d.mu - 3.4 * d.sigma;
    const hi = d.mu + 3.4 * d.sigma;
    const X = (v) => pad + ((v - lo) / (hi - lo)) * (W - pad * 2);
    const g = (v) => Math.exp(-((v - d.mu) ** 2) / (2 * d.sigma ** 2));
    const Yv = (v) => base - g(v) * (base - 42);
    const pts = [];
    for (let i = 0; i <= 90; i++) {
      const v = lo + ((hi - lo) * i) / 90;
      pts.push(`${f(X(v))},${f(Yv(v))}`);
    }
    const o = [line(pad - 6, base, W - pad + 6, base, { c: DIM, w: 1.3 })];
    if (d.shade) {
      const a = d.shade[0] ?? lo;
      const b = d.shade[1] ?? hi;
      const sp = [`${f(X(a))},${f(base)}`];
      for (let i = 0; i <= 60; i++) {
        const v = a + ((b - a) * i) / 60;
        sp.push(`${f(X(v))},${f(Yv(v))}`);
      }
      sp.push(`${f(X(b))},${f(base)}`);
      o.push(`<polygon points="${sp.join(" ")}" fill="${ROLE.key.c}" fill-opacity="0.3"/>`);
      [a, b].forEach((v) => o.push(line(X(v), base, X(v), Yv(v), { c: ROLE.key.c, w: 1.5 })));
      o.push(
        txt(W / 2, 20, `面積 ${d.area.toFixed(4)}`, { fill: ROLE.key.c, size: 11, weight: 600 }),
      );
    }
    o.push(
      `<polyline points="${pts.join(" ")}" fill="none" stroke="${CHALK}" stroke-width="1.8"/>`,
    );
    o.push(txt(X(d.mu), base + 14, `μ=${d.mu}`, { fill: DIM, size: 9 }));
    return frame(o.join(""));
  },
  tree(d) {
    const o = [];
    const levels = d.levels.length;
    const colW = (W - 50) / levels;
    let nodes = [{ x: 24, y: H / 2 }];
    o.push(`<circle cx="24" cy="${H / 2}" r="3" fill="${CHALK}"/>`);
    d.levels.forEach((opts, li) => {
      const next = [];
      nodes.forEach((n) => {
        const span = (H - 26) / (nodes.length * opts.length);
        opts.forEach((label, oi) => {
          const idx = next.length;
          const total = nodes.length * opts.length;
          const y = 16 + ((idx + 0.5) * (H - 32)) / total;
          const x = 24 + (li + 1) * colW;
          o.push(line(n.x, n.y, x, y, { c: oi === 0 ? ROLE.a.c : ROLE.b.c, w: 1.3 }));
          o.push(`<circle cx="${f(x)}" cy="${f(y)}" r="2.4" fill="${CHALK}"/>`);
          if (levels <= 3)
            o.push(txt(x + 8, y + 3, label, { fill: DIM, size: 8, anchor: "start" }));
          next.push({ x, y });
        });
      });
      nodes = next;
    });
    o.push(txt(W - 8, 14, `葉 ${d.leaves} 個`, { fill: ROLE.key.c, size: 10, anchor: "end" }));
    return frame(o.join(""));
  },
  venn(d) {
    const o = [];
    const cy = H / 2 + 6;
    const r = 52;
    const cxs = d.sets.length === 2 ? [W / 2 - 30, W / 2 + 30] : [W / 2 - 32, W / 2 + 32, W / 2];
    cxs.forEach((cx, i) => {
      o.push(
        `<circle cx="${f(cx)}" cy="${f(i === 2 ? cy + 30 : cy)}" r="${r}" fill="${i ? ROLE.b.c : ROLE.a.c}" ` +
          `fill-opacity="0.14" stroke="${i ? ROLE.b.c : ROLE.a.c}" stroke-width="1.8"/>`,
      );
      o.push(
        txt(cx + (i ? 44 : -44), cy - r + 2, d.sets[i], {
          fill: i ? ROLE.b.c : ROLE.a.c,
          size: 10,
          weight: 600,
        }),
      );
    });
    const vals = Object.values(d.counts);
    if (d.sets.length === 2 && vals.length >= 3) {
      o.push(txt(W / 2 - 52, cy + 4, vals[0], { size: 13, weight: 600 }));
      o.push(txt(W / 2, cy + 4, vals[1], { fill: ROLE.key.c, size: 13, weight: 600 }));
      o.push(txt(W / 2 + 52, cy + 4, vals[2], { size: 13, weight: 600 }));
      if (vals[3] !== undefined) o.push(txt(W - 20, H - 12, vals[3], { fill: DIM, size: 11 }));
    }
    o.push(txt(W / 2, 16, `全体 ${d.total}`, { fill: DIM, size: 10 }));
    return frame(o.join(""));
  },
  states(d, all) {
    const edges = (all.find((x) => x.t === "edges") || { edges: [] }).edges;
    const R = 74;
    const cx = W / 2;
    const cy = H / 2 + 4;
    const o = [];
    const at = {};
    d.states.forEach((s, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / d.states.length;
      at[s.name] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a };
    });
    edges.forEach((e) => {
      const p = at[e.from];
      const q = at[e.to];
      if (e.self) {
        const lx = p.x + 26 * Math.cos(p.a);
        const ly = p.y + 26 * Math.sin(p.a);
        o.push(
          `<circle cx="${f(lx)}" cy="${f(ly)}" r="13" fill="none" stroke="${ROLE.key.c}" stroke-width="1.5"/>`,
        );
        o.push(
          txt(p.x + 44 * Math.cos(p.a), p.y + 44 * Math.sin(p.a) + 3, e.prob, {
            fill: ROLE.key.c,
            size: 9,
          }),
        );
      } else {
        const u = unit(q.x - p.x, q.y - p.y);
        o.push(
          line(p.x + u.x * 17, p.y + u.y * 17, q.x - u.x * 19, q.y - u.y * 19, {
            c: ROLE.b.c,
            w: 1.5,
            marker: "ah",
          }),
        );
        o.push(
          txt((p.x + q.x) / 2 - u.y * 11, (p.y + q.y) / 2 + u.x * 11 + 3, e.prob, {
            fill: ROLE.b.c,
            size: 9,
          }),
        );
      }
    });
    d.states.forEach((s) => {
      o.push(
        `<circle cx="${f(at[s.name].x)}" cy="${f(at[s.name].y)}" r="16" fill="${BOARD}" stroke="${CHALK}" stroke-width="1.8"/>`,
      );
      o.push(txt(at[s.name].x, at[s.name].y + 4, s.name, { size: 12, weight: 600 }));
    });
    return frame(o.join(""));
  },
  seats(d) {
    const R = 62;
    const cx = W / 2;
    const cy = H / 2 + 4;
    const o = [];
    o.push(
      `<circle cx="${cx}" cy="${cy}" r="${R - 20}" fill="none" stroke="${DIM}" stroke-width="1.5" stroke-dasharray="4 4"/>`,
    );
    d.seats.forEach((s, i) => {
      const a = Math.PI / 2 - (2 * Math.PI * i) / d.n;
      const x = cx + R * Math.cos(a);
      const y = cy - R * Math.sin(a);
      const c = s.fixed ? ROLE.key.c : CHALK;
      o.push(
        `<circle cx="${f(x)}" cy="${f(y)}" r="14" fill="${s.fixed ? ROLE.key.c : BOARD}" fill-opacity="${s.fixed ? 0.25 : 1}" stroke="${c}" stroke-width="1.8"/>`,
      );
      o.push(txt(x, y + 4, s.name ?? i + 1, { fill: c, size: 11, weight: 600 }));
    });
    if (d.fix) o.push(txt(W / 2, 16, `${d.fix} を固定して考える`, { fill: ROLE.key.c, size: 10 }));
    return frame(o.join(""));
  },
  balls(d) {
    const o = [];
    const kinds = Object.entries(d.kinds);
    const COL = [ROLE.a.c, CHALK, ROLE.b.c, ROLE.key.c];
    o.push(
      `<rect x="46" y="42" width="${W - 92}" height="${H - 86}" rx="18" fill="none" stroke="${DIM}" stroke-width="2"/>`,
    );
    if (d.container) o.push(txt(W / 2, 32, d.container, { fill: DIM, size: 11 }));
    const cols = Math.ceil(Math.sqrt(d.balls.length));
    d.balls.forEach((b, i) => {
      const cx = W / 2 + ((i % cols) - (cols - 1) / 2) * 30;
      const cy = 74 + Math.floor(i / cols) * 30;
      o.push(
        `<circle cx="${f(cx)}" cy="${f(cy)}" r="11" fill="${COL[b.ki % 4]}" fill-opacity="0.55" stroke="${COL[b.ki % 4]}" stroke-width="1.6"/>`,
      );
    });
    o.push(
      txt(W / 2, H - 12, kinds.map(([k, n]) => `${k}${n}`).join(" / "), { fill: DIM, size: 10 }),
    );
    return frame(o.join(""));
  },
  dice(d) {
    const o = [];
    const n = d.faces.length;
    const S = 62;
    d.faces.forEach((face, i) => {
      const x0 = W / 2 + (i - (n - 1) / 2) * (S + 24) - S / 2;
      const y0 = H / 2 - S / 2;
      o.push(
        `<rect x="${f(x0)}" y="${f(y0)}" width="${S}" height="${S}" rx="10" fill="${BOARD}" stroke="${CHALK}" stroke-width="2"/>`,
      );
      face.pips.forEach(([px, py]) => {
        o.push(
          `<circle cx="${f(x0 + S / 2 + px * 17)}" cy="${f(y0 + S / 2 - py * 17)}" r="5" fill="${ROLE.key.c}"/>`,
        );
      });
      o.push(txt(x0 + S / 2, y0 + S + 18, face.value, { fill: DIM, size: 10 }));
    });
    return frame(o.join(""));
  },
  diceTable(d) {
    const o = [];
    const S = 26;
    const x0 = (W - S * 6) / 2 + 8;
    const y0 = 34;
    for (let a = 1; a <= 6; a++) {
      o.push(txt(x0 - 12, y0 + (a - 0.5) * S + 4, a, { fill: DIM, size: 9 }));
      o.push(txt(x0 + (a - 0.5) * S, y0 - 6, a, { fill: DIM, size: 9 }));
    }
    d.cells.forEach((c) => {
      const x = x0 + (c.b - 1) * S;
      const y = y0 + (c.a - 1) * S;
      o.push(
        `<rect x="${f(x)}" y="${f(y)}" width="${S}" height="${S}" fill="${c.mark ? ROLE.key.c : "none"}" ` +
          `fill-opacity="${c.mark ? 0.35 : 0}" stroke="${DIM}" stroke-width="0.7"/>`,
      );
    });
    o.push(
      txt(W / 2, H - 10, `和が${d.markSum} → ${d.marked} 通り`, { fill: ROLE.key.c, size: 10 }),
    );
    return frame(o.join(""));
  },
  signTable(d) {
    // 増減表は「表」なので、SVG の中に罫線と文字で組む
    const cols = d.crit.length * 2 + 1;
    const rows = d.concave ? 4 : 3;
    const x0 = 22;
    const y0 = 44;
    const cw = (W - 44) / (cols + 1);
    const rh = 30;
    const o = [txt(W / 2, 24, `y = ${d.curve} の増減表`, { fill: DIM, size: 10 })];
    for (let i = 0; i <= cols + 1; i++)
      o.push(line(x0 + i * cw, y0, x0 + i * cw, y0 + rows * rh, { c: DIM, w: 0.8 }));
    for (let j = 0; j <= rows; j++)
      o.push(line(x0, y0 + j * rh, x0 + (cols + 1) * cw, y0 + j * rh, { c: DIM, w: 0.8 }));
    const labels = ["x", "f′", ...(d.concave ? ["f″"] : []), "f"];
    labels.forEach((s, j) =>
      o.push(txt(x0 + cw / 2, y0 + (j + 0.65) * rh, s, { size: 11, weight: 600 })),
    );
    // x の行:  … c1 … c2 …
    for (let i = 0; i < cols; i++) {
      const cx = x0 + (i + 1.5) * cw;
      if (i % 2 === 1)
        o.push(
          txt(cx, y0 + 0.65 * rh, f(d.crit[(i - 1) / 2]), {
            fill: ROLE.key.c,
            size: 11,
            weight: 600,
          }),
        );
      else o.push(txt(cx, y0 + 0.65 * rh, "⋯", { fill: DIM, size: 11 }));
    }
    // f′ の行
    for (let i = 0; i < cols; i++) {
      const cx = x0 + (i + 1.5) * cw;
      const s = i % 2 === 1 ? "0" : d.sign[i / 2];
      o.push(
        txt(cx, y0 + 1.65 * rh, s, {
          fill: s === "+" ? ROLE.b.c : s === "-" ? ROLE.a.c : ROLE.key.c,
          size: 12,
          weight: 600,
        }),
      );
    }
    let row = 2;
    if (d.concave) {
      for (let i = 0; i < cols; i++) {
        const cx = x0 + (i + 1.5) * cw;
        const s = i % 2 === 1 ? "0" : d.concave[i / 2] === "下に凸" ? "∪" : "∩";
        o.push(txt(cx, y0 + (row + 0.68) * rh, s, { fill: DIM, size: 12 }));
      }
      row++;
    }
    for (let i = 0; i < cols; i++) {
      const cx = x0 + (i + 1.5) * cw;
      const s = i % 2 === 1 ? f(d.values[(i - 1) / 2].y) : d.arrow[i / 2];
      o.push(
        txt(cx, y0 + (row + 0.68) * rh, s, {
          fill: i % 2 === 1 ? ROLE.key.c : CHALK,
          size: 12,
          weight: i % 2 ? 600 : 400,
        }),
      );
    }
    return frame(o.join(""), W, y0 + rows * rh + 20);
  },
  groups(d) {
    const o = [];
    const pad = 18;
    const total = d.total;
    const cw = (W - pad * 2) / total;
    const y = H / 2;
    d.groups.forEach((g, gi) => {
      const x0 = pad + (g.from - 1) * cw;
      const w = g.n * cw;
      o.push(
        `<rect x="${f(x0 + 1)}" y="${f(y - 18)}" width="${f(w - 2)}" height="36" rx="5" ` +
          `fill="${gi % 2 ? ROLE.b.c : ROLE.a.c}" fill-opacity="0.2" stroke="${gi % 2 ? ROLE.b.c : ROLE.a.c}" stroke-width="1.5"/>`,
      );
      o.push(txt(x0 + w / 2, y + 5, `第${g.i}群`, { size: 10, weight: 600 }));
      o.push(txt(x0 + w / 2, y + 32, `${g.from}〜${g.to}`, { fill: DIM, size: 9 }));
    });
    o.push(txt(W / 2, 22, "通し番号はこちらが積み上げる", { fill: DIM, size: 9 }));
    return frame(o.join(""));
  },
};

export function render(result) {
  const draws = result.draws;
  for (const d of draws) {
    if (SPECIAL[d.t]) return SPECIAL[d.t](d, draws);
  }
  return geometric(draws);
}
