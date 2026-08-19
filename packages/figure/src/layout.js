/**
 * 幾何図を、モバイルへ送る固定 viewBox に収めるための座標変換。
 *
 * 品質検査と描画が別々の変換を持つと、「lint では内側、SVG では外側」のような
 * 食い違いが生まれる。ここを両方の正にする。
 */

/** モバイルが前提にしている 10:7 の横幅。345pt で表示すると約1.08倍になる。 */
export const figureViewBoxWidth = 320;

/** 320:224 = 10:7。345pt 幅でも高さは約242ptで、端末側の260pt上限に収まる。 */
export const figureViewBoxHeight = 224;

/** 横余白は viewBox の9.375%。10pxラベルを左右で切らず、描画域を狭めすぎない線。 */
export const figureHorizontalMargin = 30;

/** 縦余白も viewBox の9.375%。内側260×182もモバイルと同じ10:7になる。 */
export const figureVerticalMargin = 21;

const SPECIAL_LAYOUTS = new Set([
  "numberLine",
  "boxplot",
  "histogram",
  "normal",
  "tree",
  "venn",
  "states",
  "seats",
  "balls",
  "dice",
  "diceTable",
  "signTable",
  "groups",
]);

/** 座標ではなく専用テンプレートで置く図表か。これらにはLLM由来の配置自由度が無い。 */
export function hasSpecialLayout(result) {
  return result.draws.some((draw) => SPECIAL_LAYOUTS.has(draw.t));
}

/** 軸の表示範囲。極を持つ曲線の外れ値を、枠の計算へ混ぜないために使う。 */
export function figureClip(result) {
  const axes = result.draws.find((draw) => draw.t === "axes");
  return axes ? { x0: axes.span[0], x1: axes.span[1], y0: axes.span[2], y1: axes.span[3] } : null;
}

export function isInsideFigureClip(point, clip) {
  return (
    clip === null ||
    (point.x >= clip.x0 - 1e-9 &&
      point.x <= clip.x1 + 1e-9 &&
      point.y >= clip.y0 - 1e-9 &&
      point.y <= clip.y1 + 1e-9)
  );
}

/**
 * 描画命令が占める座標範囲。
 *
 * `render.js` が実際に描く形を列挙する。散布図だけ `[x,y]` なので分けて扱い、
 * 円・楕円は中心だけでなく輪郭まで含める。
 */
export function figureGeometryBounds(result) {
  const xs = [];
  const ys = [];
  const clip = figureClip(result);
  const eat = (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (!isInsideFigureClip(point, clip)) return;
    xs.push(point.x);
    ys.push(point.y);
  };

  for (const draw of result.draws) {
    eat(draw.p);
    eat(draw.a);
    eat(draw.b);
    eat(draw.o);
    eat(draw.c);
    if (draw.t === "scatter") {
      for (const point of draw.ps) eat({ x: point[0], y: point[1] });
    } else {
      for (const point of draw.ps || []) eat(point);
    }
    for (const point of draw.cells || []) eat(point);

    if (draw.t === "complexPlane") {
      xs.push(-draw.span, draw.span);
      ys.push(-draw.span, draw.span);
    }
    if (draw.t === "circle") {
      xs.push(draw.c.x - draw.r, draw.c.x + draw.r);
      ys.push(draw.c.y - draw.r, draw.c.y + draw.r);
    }
    if (draw.t === "ellipse") {
      xs.push(draw.c.x - draw.rx, draw.c.x + draw.rx);
      ys.push(draw.c.y - draw.ry, draw.c.y + draw.ry);
    }
    if (draw.t === "axes") {
      xs.push(draw.span[0], draw.span[1]);
      ys.push(draw.span[2], draw.span[3]);
    }
    if (draw.t === "unitCircle") {
      xs.push(-1.25, 1.25);
      ys.push(-1.25, 1.25);
    }
    if (draw.t === "conic") {
      const radius = draw.kind === "parabola" ? draw.a * 4 : draw.c * 1.3;
      xs.push(-radius, radius);
      ys.push(-radius * 0.75, radius * 0.75);
    }
    if (draw.t === "riemann") {
      for (const bar of draw.bars) {
        xs.push(bar.from, bar.to);
        ys.push(0, bar.h);
      }
    }
    if (draw.t === "asymptote") {
      if (draw.x !== undefined) xs.push(draw.x);
      if (draw.y !== undefined) ys.push(draw.y);
    }
  }

  if (xs.length === 0) {
    xs.push(-1, 1);
    ys.push(-1, 1);
  }

  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);

  // 1本の縦線・横線でも有限の枠を作る。中心を動かさないことが重要。
  if (x1 - x0 < 1e-9) {
    const center = (x0 + x1) / 2;
    x0 = center - 0.5;
    x1 = center + 0.5;
  }
  if (y1 - y0 < 1e-9) {
    const center = (y0 + y1) / 2;
    y0 = center - 0.5;
    y1 = center + 0.5;
  }

  return { x0, x1, y0, y1, clip };
}

/**
 * 320×224へ等方的に自動フィットする。
 *
 * 極端に横長・縦長でも x/y を別倍率にして歪めない。短い側の仮想範囲を広げて
 * 内側の10:7へ合わせるので、円は円、直角は直角のまま中央へ収まる。
 */
export function createFigureLayout(result) {
  const raw = figureGeometryBounds(result);
  const availableWidth = figureViewBoxWidth - figureHorizontalMargin * 2;
  const availableHeight = figureViewBoxHeight - figureVerticalMargin * 2;
  const targetAspect = availableWidth / availableHeight;

  let x0 = raw.x0;
  let x1 = raw.x1;
  let y0 = raw.y0;
  let y1 = raw.y1;
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;
  const spanX = x1 - x0;
  const spanY = y1 - y0;

  if (spanX / spanY > targetAspect) {
    const fittedHeight = spanX / targetAspect;
    y0 = centerY - fittedHeight / 2;
    y1 = centerY + fittedHeight / 2;
  } else {
    const fittedWidth = spanY * targetAspect;
    x0 = centerX - fittedWidth / 2;
    x1 = centerX + fittedWidth / 2;
  }

  const scale = Math.min(availableWidth / (x1 - x0), availableHeight / (y1 - y0));
  const fittedCenterX = (x0 + x1) / 2;
  const fittedCenterY = (y0 + y1) / 2;

  return {
    width: figureViewBoxWidth,
    height: figureViewBoxHeight,
    scale,
    rawBounds: raw,
    fittedBounds: { x0, x1, y0, y1 },
    clip: raw.clip,
    x(value) {
      return figureViewBoxWidth / 2 + (value - fittedCenterX) * scale;
    },
    y(value) {
      return figureViewBoxHeight / 2 - (value - fittedCenterY) * scale;
    },
  };
}
