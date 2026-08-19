import {
  createFigureLayout,
  figureViewBoxHeight,
  figureViewBoxWidth,
  hasSpecialLayout,
  isInsideFigureClip,
} from "./layout.js";
import { solve } from "./solve.js";

/**
 * 10pxの点名を2つ並べても、345pt幅の端末で1文字ぶん以上の空きが残る距離。
 * 320px viewBox は実機で約1.08倍になるため、16px ≒ 17ptとして読める。
 */
export const figureMinPointDistancePx = 16;

/**
 * 半径80pxほどの三角形で、隣の辺との開きが約17pxになる角度。
 * これ未満は10pxラベルより狭くなり、頂点が視覚上つぶれる。
 */
export const figureMinEdgeAngleDeg = 12;

/**
 * SVGの文字は端末でもほぼ同じpt数になる。2px(実機約2.2pt)を空け、
 * 接して1語に見えるラベルを衝突として扱う。
 */
export const figureLabelGapPx = 2;

/**
 * 小数座標をSVGで小数第2位に丸めるぶんだけ1pxを許す。
 * それ以上は320×224のクリップで欠けるため配送しない。
 */
export const figureMaxOverflowPx = 1;

const LABEL_FONT_SIZE = 10;
const LABEL_HEIGHT = LABEL_FONT_SIZE * 1.15;
const POINT_RADIUS_WITH_GAP = 5;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const round = (value) => Math.round(value * 100) / 100;

function labelWidth(text) {
  return [...String(text)].reduce(
    (width, character) => width + LABEL_FONT_SIZE * (character.codePointAt(0) <= 0x7f ? 0.62 : 1),
    0,
  );
}

function labelBox(descriptor, offset = descriptor.defaultOffset) {
  const centerX = descriptor.anchor.x + offset.x;
  const baselineY = descriptor.anchor.y + offset.y;
  const width = descriptor.width;
  return {
    key: descriptor.key,
    text: descriptor.text,
    x0: centerX - width / 2,
    x1: centerX + width / 2,
    y0: baselineY - LABEL_HEIGHT,
    y1: baselineY + 3,
  };
}

function overlap(a, b, gap = 0) {
  const x = Math.min(a.x1 + gap / 2, b.x1 + gap / 2) - Math.max(a.x0 - gap / 2, b.x0 - gap / 2);
  const y = Math.min(a.y1 + gap / 2, b.y1 + gap / 2) - Math.max(a.y0 - gap / 2, b.y0 - gap / 2);
  return x > 0 && y > 0 ? x * y : 0;
}

function boxOverflow(box) {
  return Math.max(0, -box.x0, -box.y0, box.x1 - figureViewBoxWidth, box.y1 - figureViewBoxHeight);
}

function labelDescriptors(result, layout) {
  const descriptors = [];
  for (const [index, draw] of result.draws.entries()) {
    if (draw.t === "pt" && (draw.coord || draw.name)) {
      const text = draw.coord ? `${draw.name ?? ""}${draw.coord}` : draw.name;
      descriptors.push({
        key: `${index}:point`,
        index,
        kind: "point",
        text: String(text),
        width: labelWidth(text),
        anchor: { x: layout.x(draw.p.x), y: layout.y(draw.p.y) },
        defaultOffset: { x: 0, y: draw.coord ? -8 : -7 },
        source: draw.p,
      });
      continue;
    }
    if (draw.t === "seg" && (draw.label || draw.part !== undefined)) {
      const text = draw.label ?? draw.part;
      const a = { x: layout.x(draw.a.x), y: layout.y(draw.a.y) };
      const b = { x: layout.x(draw.b.x), y: layout.y(draw.b.y) };
      descriptors.push({
        key: `${index}:segment`,
        index,
        kind: "line",
        text: String(text),
        width: labelWidth(text),
        anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        defaultOffset: { x: 0, y: -5 },
        direction: { x: b.x - a.x, y: b.y - a.y },
      });
      continue;
    }
    if (draw.t === "vec" && draw.label) {
      const a = { x: layout.x(draw.a.x), y: layout.y(draw.a.y) };
      const b = { x: layout.x(draw.b.x), y: layout.y(draw.b.y) };
      descriptors.push({
        key: `${index}:vector`,
        index,
        kind: "line",
        text: String(draw.label),
        width: labelWidth(draw.label),
        anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        defaultOffset: { x: 8, y: -4 },
        direction: { x: b.x - a.x, y: b.y - a.y },
      });
      continue;
    }
    if (draw.t === "arc" && draw.label) {
      const origin = { x: layout.x(draw.o.x), y: layout.y(draw.o.y) };
      const a1 = Math.atan2(layout.y(draw.a.y) - origin.y, layout.x(draw.a.x) - origin.x);
      const a2 = Math.atan2(layout.y(draw.b.y) - origin.y, layout.x(draw.b.x) - origin.x);
      const delta = (a2 - a1 + Math.PI * 3) % (Math.PI * 2);
      const middle = a1 + (delta > Math.PI ? a2 - a1 - Math.PI * 2 : a2 - a1) / 2;
      const radial = { x: Math.cos(middle), y: Math.sin(middle) };
      descriptors.push({
        key: `${index}:arc`,
        index,
        kind: "radial",
        text: String(draw.label),
        width: labelWidth(draw.label),
        anchor: { x: origin.x + 32 * radial.x, y: origin.y + 32 * radial.y + 3 },
        defaultOffset: { x: 0, y: 0 },
        radial,
      });
    }
  }
  return descriptors;
}

function candidateOffsets(descriptor) {
  if (descriptor.kind === "point") {
    const side = descriptor.width / 2 + 8;
    return [
      descriptor.defaultOffset,
      { x: 0, y: -24 },
      { x: side, y: -5 },
      { x: -side, y: -5 },
      { x: side, y: LABEL_HEIGHT + 7 },
      { x: -side, y: LABEL_HEIGHT + 7 },
      { x: 0, y: LABEL_HEIGHT + 9 },
      { x: 0, y: -40 },
      { x: 0, y: LABEL_HEIGHT + 25 },
      { x: side + 4, y: 4 },
      { x: -side - 4, y: 4 },
    ];
  }
  if (descriptor.kind === "line") {
    const length = Math.hypot(descriptor.direction.x, descriptor.direction.y) || 1;
    const normal = {
      x: -descriptor.direction.y / length,
      y: descriptor.direction.x / length,
    };
    return [
      descriptor.defaultOffset,
      { x: normal.x * 12, y: normal.y * 12 + 3 },
      { x: -normal.x * 12, y: -normal.y * 12 + 3 },
      { x: normal.x * 20, y: normal.y * 20 + 3 },
      { x: -normal.x * 20, y: -normal.y * 20 + 3 },
    ];
  }
  if (descriptor.kind === "radial") {
    return [
      descriptor.defaultOffset,
      { x: descriptor.radial.x * 10, y: descriptor.radial.y * 10 },
      { x: -descriptor.radial.x * 9, y: -descriptor.radial.y * 9 },
      { x: -descriptor.radial.y * 10, y: descriptor.radial.x * 10 },
      { x: descriptor.radial.y * 10, y: -descriptor.radial.x * 10 },
    ];
  }
  return [descriptor.defaultOffset];
}

function pointObstacles(result, layout) {
  return result.draws
    .filter((draw) => draw.t === "pt")
    .map((draw) => {
      const x = layout.x(draw.p.x);
      const y = layout.y(draw.p.y);
      return {
        x0: x - POINT_RADIUS_WITH_GAP,
        x1: x + POINT_RADIUS_WITH_GAP,
        y0: y - POINT_RADIUS_WITH_GAP,
        y1: y + POINT_RADIUS_WITH_GAP,
      };
    });
}

function scoreIsLower(score, best) {
  for (let index = 0; index < score.length; index += 1) {
    if (score[index] === best[index]) continue;
    return score[index] < best[index];
  }
  return false;
}

/**
 * ラベルを8方位(線上ラベルは両法線側)から決定的に選ぶ。
 *
 * 乱数も反復順の不定な集合も使わない。同じ draws なら候補順・採用位置とも同じになる。
 */
export function applyFigureLabelLayout(result) {
  if (hasSpecialLayout(result)) return result;
  const layout = createFigureLayout(result);
  const descriptors = labelDescriptors(result, layout);
  if (descriptors.length === 0) return result;

  const placed = [];
  const pointBoxes = pointObstacles(result, layout);
  const chosen = new Map();

  for (const descriptor of descriptors) {
    let best = null;
    for (const [order, offset] of candidateOffsets(descriptor).entries()) {
      const box = labelBox(descriptor, offset);
      const labelOverlap = placed.reduce(
        (sum, other) => sum + overlap(box, other, figureLabelGapPx),
        0,
      );
      const pointOverlap = pointBoxes.reduce((sum, point) => sum + overlap(box, point), 0);
      const overflow = boxOverflow(box);
      // 辞書順なら面積の大小に左右されず、欠け→ラベル同士→点の優先順位を守れる。
      const score = [overflow, labelOverlap, pointOverlap, order];
      if (best === null || scoreIsLower(score, best.score)) best = { offset, box, score };
    }
    chosen.set(descriptor.index, best.offset);
    placed.push(best.box);
  }

  return {
    ...result,
    draws: result.draws.map((draw, index) => {
      const labelOffset = chosen.get(index);
      return labelOffset === undefined ? draw : { ...draw, labelOffset };
    }),
  };
}

function visiblePoints(result, layout) {
  const seen = new Set();
  const points = [];
  for (const draw of result.draws) {
    if (draw.t !== "pt") continue;
    const key = draw.name ?? `${draw.p.x},${draw.p.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({
      name: String(draw.name ?? "?"),
      x: layout.x(draw.p.x),
      y: layout.y(draw.p.y),
    });
  }
  return points;
}

function edgesOf(result) {
  const edges = [];
  for (const [index, draw] of result.draws.entries()) {
    if ((draw.t === "seg" || draw.t === "vec") && draw.a && draw.b) {
      edges.push({
        a: draw.a,
        b: draw.b,
        names: draw.names ?? ["?", "?"],
        source: `${draw.t}:${index}`,
      });
    }
    if (draw.t === "poly") {
      for (let at = 0; at < draw.ps.length; at += 1) {
        const next = (at + 1) % draw.ps.length;
        edges.push({
          a: draw.ps[at],
          b: draw.ps[next],
          names: draw.names ? [draw.names[at], draw.names[next]] : ["?", "?"],
          source: `poly:${index}`,
        });
      }
    }
  }
  return edges;
}

function sharedAngle(first, second) {
  const pairs = [
    [first.a, first.b, second.a, second.b, first.names[0]],
    [first.a, first.b, second.b, second.a, first.names[0]],
    [first.b, first.a, second.a, second.b, first.names[1]],
    [first.b, first.a, second.b, second.a, first.names[1]],
  ];
  for (const [originA, endA, originB, endB, name] of pairs) {
    if (distance(originA, originB) > 1e-8) continue;
    const ux = endA.x - originA.x;
    const uy = endA.y - originA.y;
    const vx = endB.x - originB.x;
    const vy = endB.y - originB.y;
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (length < 1e-12) return { angle: 0, name };
    const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / length));
    return { angle: (Math.acos(cosine) * 180) / Math.PI, name };
  }
  return null;
}

function minimumEdgeAngle(result) {
  const edges = edgesOf(result);
  let minimum = null;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const hit = sharedAngle(edges[i], edges[j]);
      if (hit === null) continue;
      // 同じ線を色付きで重ねる描き方は角のつぶれではない。1つの多角形内の0°は検出する。
      if (hit.angle < 1e-7 && edges[i].source !== edges[j].source) continue;
      if (minimum === null || hit.angle < minimum.angle) {
        minimum = {
          angle: hit.angle,
          at: hit.name,
          edges: [edges[i].names.join(""), edges[j].names.join("")],
        };
      }
    }
  }
  return minimum;
}

function renderedBounds(result, layout, boxes) {
  const xs = [];
  const ys = [];
  const eat = (point, radius = 0) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    xs.push(layout.x(point.x) - radius, layout.x(point.x) + radius);
    ys.push(layout.y(point.y) - radius, layout.y(point.y) + radius);
  };

  for (const draw of result.draws) {
    if (draw.t === "curve") {
      for (const point of draw.ps || []) {
        if (isInsideFigureClip(point, layout.clip)) eat(point, 2);
      }
      continue;
    }
    if (draw.t === "pt") eat(draw.p, 3);
    if (draw.t === "seg" || draw.t === "vec") {
      eat(draw.a, draw.t === "vec" ? 8 : 2);
      eat(draw.b, draw.t === "vec" ? 8 : 2);
    }
    if (draw.t === "poly") for (const point of draw.ps) eat(point, 2);
    if (draw.t === "arc" || draw.t === "right") {
      eat(draw.a, 2);
      eat(draw.b, 2);
      eat(draw.o, 20);
    }
    if (draw.t === "circle") {
      xs.push(
        layout.x(draw.c.x) - draw.r * layout.scale,
        layout.x(draw.c.x) + draw.r * layout.scale,
      );
      ys.push(
        layout.y(draw.c.y) - draw.r * layout.scale,
        layout.y(draw.c.y) + draw.r * layout.scale,
      );
    }
    if (draw.t === "ellipse") {
      xs.push(
        layout.x(draw.c.x) - draw.rx * layout.scale,
        layout.x(draw.c.x) + draw.rx * layout.scale,
      );
      ys.push(
        layout.y(draw.c.y) - draw.ry * layout.scale,
        layout.y(draw.c.y) + draw.ry * layout.scale,
      );
    }
  }
  for (const box of boxes) {
    xs.push(box.x0, box.x1);
    ys.push(box.y0, box.y1);
  }
  if (xs.length === 0) return { x0: 0, x1: figureViewBoxWidth, y0: 0, y1: figureViewBoxHeight };
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * solve 後の図を、実際の viewBox 上で測る純関数。
 *
 * `issues` は不変量名・実測値・閾値・不足量を持つ。文字列だけを返さないのは、
 * agent の guidance と figeval が同じ測定結果を別の用途で使うため。
 */
export function lintFigure(result) {
  if (hasSpecialLayout(result)) {
    return {
      ok: true,
      issues: [],
      metrics: {
        minPointDistancePx: null,
        minEdgeAngleDeg: null,
        labelCollisionCount: 0,
        maxLabelOverlapPx2: 0,
        maxOverflowPx: 0,
      },
    };
  }

  const layout = createFigureLayout(result);
  const points = visiblePoints(result, layout);
  let closest = null;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const actual = distance(points[i], points[j]);
      if (closest === null || actual < closest.actual)
        closest = { actual, points: [points[i].name, points[j].name] };
    }
  }

  const angle = minimumEdgeAngle(result);
  const descriptors = labelDescriptors(result, layout);
  const boxes = descriptors.map((descriptor) => {
    const offset = result.draws[descriptor.index].labelOffset ?? descriptor.defaultOffset;
    return labelBox(descriptor, offset);
  });
  const collisions = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const area = overlap(boxes[i], boxes[j], figureLabelGapPx);
      if (area > 0) collisions.push({ area, labels: [boxes[i].text, boxes[j].text] });
    }
  }
  collisions.sort((a, b) => b.area - a.area);

  const bounds = renderedBounds(result, layout, boxes);
  const overflow = Math.max(
    0,
    -bounds.x0,
    -bounds.y0,
    bounds.x1 - figureViewBoxWidth,
    bounds.y1 - figureViewBoxHeight,
  );

  const issues = [];
  if (closest !== null && closest.actual < figureMinPointDistancePx) {
    issues.push({
      invariant: "point_distance",
      actual: round(closest.actual),
      threshold: figureMinPointDistancePx,
      deficit: round(figureMinPointDistancePx - closest.actual),
      unit: "px",
      entities: closest.points,
      message: `${closest.points.join("と")}が近すぎます(${round(closest.actual)}px、基準${figureMinPointDistancePx}px)。`,
    });
  }
  if (angle !== null && angle.angle < figureMinEdgeAngleDeg) {
    issues.push({
      invariant: "edge_angle",
      actual: round(angle.angle),
      threshold: figureMinEdgeAngleDeg,
      deficit: round(figureMinEdgeAngleDeg - angle.angle),
      unit: "deg",
      entities: [String(angle.at), ...angle.edges],
      message: `${angle.at}で辺の角度がつぶれています(${round(angle.angle)}°、基準${figureMinEdgeAngleDeg}°)。`,
    });
  }
  if (collisions.length > 0) {
    issues.push({
      invariant: "label_collision",
      actual: round(collisions[0].area),
      threshold: 0,
      deficit: round(collisions[0].area),
      unit: "px2",
      entities: collisions[0].labels,
      message: `ラベル「${collisions[0].labels.join("」「")}」が重なっています。`,
    });
  }
  if (overflow > figureMaxOverflowPx) {
    issues.push({
      invariant: "viewbox_overflow",
      actual: round(overflow),
      threshold: figureMaxOverflowPx,
      deficit: round(overflow - figureMaxOverflowPx),
      unit: "px",
      entities: [],
      message: `図の要素がviewBoxから${round(overflow)}pxはみ出しています。`,
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      minPointDistancePx: closest === null ? null : round(closest.actual),
      minEdgeAngleDeg: angle === null ? null : round(angle.angle),
      labelCollisionCount: collisions.length,
      maxLabelOverlapPx2: collisions.length === 0 ? 0 : round(collisions[0].area),
      maxOverflowPx: round(overflow),
    },
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function relationPart(item) {
  const movablePoint = typeof item.pt === "string";
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => {
      if (!movablePoint) return true;
      if (key === "at" && item.showCoord !== true) return false;
      if (key === "deg" && (item.from || typeof item.on === "string")) return false;
      if (key === "dist" && item.from) return false;
      return true;
    }),
  );
}

/** 点名・参照先・線上/円周上/交点などの関係が、修正前後で同一かを検算する。 */
export function figureRelationsPreserved(original, candidate) {
  if (original.length !== candidate.length) return false;
  return original.every(
    (item, index) =>
      JSON.stringify(stable(relationPart(item))) ===
      JSON.stringify(stable(relationPart(candidate[index]))),
  );
}

/** 3点のなす角(度)。どれかが解けていなければ `null`。 */
function angleAtVertex(points, aName, oName, bName) {
  const a = points[aName];
  const o = points[oName];
  const b = points[bName];
  if (!a || !o || !b) return null;
  const first = Math.hypot(a.x - o.x, a.y - o.y);
  const second = Math.hypot(b.x - o.x, b.y - o.y);
  if (first === 0 || second === 0) return null;
  const cos = ((a.x - o.x) * (b.x - o.x) + (a.y - o.y) * (b.y - o.y)) / (first * second);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * **図が主張している角度が、修正の前後で変わっていないか。**
 *
 * `figureRelationsPreserved` は宣言の**字面**しか見ないので、`at` を置き直したり
 * `deg` を散らしたりしても「関係は同じ」と通る。ところが直角マーク(`right`)は
 * 「その角は90°だ」という**幾何の主張**で、点を動かすとマークだけが残って中身が
 * 70°になりうる — 実測した挙動そのもの。崩れた図より悪い、こちらが作った
 * 「生徒が気づけない誤り」なので、見栄えの修正では絶対に動かさない。
 *
 * 元から主張とずれている図(LLMが90°でない角に直角マークを付けた)は、ここでは直さない。
 * 直すのは可読性だけで、幾何の誤りは作り直しの guidance が拾う。**前後で同じ**を見る。
 */
function declaredAnglesPreserved(items, before, after) {
  for (const item of items) {
    if (!Array.isArray(item.right) || item.right.length < 3) continue;
    const [a, o, b] = item.right;
    const beforeAngle = angleAtVertex(before.pts, a, o, b);
    const afterAngle = angleAtVertex(after.pts, a, o, b);
    if (beforeAngle === null || afterAngle === null) continue;
    // 0.5°は、座標を小数第2位へ丸めるぶんだけを許す幅。
    if (Math.abs(beforeAngle - afterAngle) > 0.5) return false;
  }
  return true;
}

function cloneItems(items) {
  return items.map((item) => ({
    ...item,
    ...(Array.isArray(item.at) ? { at: [...item.at] } : {}),
  }));
}

function spreadAngles(items, phase = 0) {
  const next = cloneItems(items);
  const groups = new Map();
  for (const [index, item] of next.entries()) {
    if (typeof item.pt !== "string" || typeof item.deg !== "number") continue;
    const key =
      item.from && item.dist !== undefined
        ? `from:${item.from}`
        : typeof item.on === "string"
          ? `on:${item.on}`
          : null;
    if (key === null) continue;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }

  let changed = false;
  for (const [key, indices] of groups) {
    if (indices.length === 1) {
      if (phase === 0) continue;
      next[indices[0]].deg += phase;
      changed = true;
      continue;
    }
    if (key.startsWith("on:")) {
      const start = next[indices[0]].deg + phase;
      for (const [order, index] of indices.entries()) {
        const value = start + (360 * order) / indices.length;
        if (next[index].deg !== value) changed = true;
        next[index].deg = value;
      }
      continue;
    }
    const center =
      indices.reduce((sum, index) => sum + next[index].deg, 0) / indices.length + phase;
    const step = Math.min(70, 160 / (indices.length - 1));
    for (const [order, index] of indices.entries()) {
      const value = center + (order - (indices.length - 1) / 2) * step;
      if (next[index].deg !== value) changed = true;
      next[index].deg = value;
    }
  }
  return changed ? { items: next, change: "angle_resampling" } : null;
}

function normalizeAnchors(items) {
  // 座標そのものを説明する図は、見栄えのために動かしてはいけない。
  if (
    items.some(
      (item) =>
        item.axes !== undefined ||
        item.curve ||
        item.polar ||
        item.complexPlane ||
        item.scatter ||
        item.lattice ||
        item.onCurve !== undefined ||
        item.showCoord === true,
    )
  ) {
    return null;
  }
  const indices = items
    .map((item, index) => (typeof item.pt === "string" && Array.isArray(item.at) ? index : -1))
    .filter((index) => index >= 0);
  if (indices.length < 2) return null;

  const positions = [];
  if (indices.length === 2) positions.push([-3, 0], [3, 0]);
  else if (indices.length === 3) positions.push([0, 3], [-3.5, -2], [3.5, -2]);
  else if (indices.length === 4) positions.push([-3.5, -2.2], [3.5, -2.2], [3.5, 2.2], [-3.5, 2.2]);
  else {
    for (let index = 0; index < indices.length; index += 1) {
      const angle = Math.PI / 2 + (2 * Math.PI * index) / indices.length;
      positions.push([4 * Math.cos(angle), 3 * Math.sin(angle)]);
    }
  }

  const next = cloneItems(items);
  let changed = false;
  for (const [order, index] of indices.entries()) {
    if (next[index].at[0] !== positions[order][0] || next[index].at[1] !== positions[order][1]) {
      changed = true;
    }
    next[index].at = positions[order];
  }
  return changed ? { items: next, change: "anchor_resampling" } : null;
}

function resampleDistances(items) {
  const protectedEdges = new Set();
  for (const item of items) {
    if (!Array.isArray(item.seg)) continue;
    const numeric =
      typeof item.label === "string" && /^\d+(?:\.\d+)?\s*(?:cm|mm|m|km)?$/.test(item.label.trim());
    if (!numeric && item.showLength !== true) continue;
    protectedEdges.add([...item.seg].sort().join("\u0000"));
  }

  const next = cloneItems(items);
  let changed = false;
  let order = 0;
  for (const item of next) {
    if (
      typeof item.pt !== "string" ||
      typeof item.from !== "string" ||
      typeof item.dist !== "number"
    )
      continue;
    const edge = [item.pt, item.from].sort().join("\u0000");
    if (protectedEdges.has(edge) || item.showCoord === true) continue;
    const value = Math.min(8, Math.max(3 + (order % 3) * 0.5, Math.abs(item.dist)));
    order += 1;
    if (Math.abs(value - item.dist) < 1e-9) continue;
    item.dist = value;
    changed = true;
  }
  return changed ? { items: next, change: "distance_resampling" } : null;
}

function combine(items, transforms) {
  let current = items;
  const changes = [];
  for (const transform of transforms) {
    const transformed = transform(current);
    if (transformed === null) continue;
    current = transformed.items;
    changes.push(transformed.change);
  }
  return changes.length === 0 ? null : { items: current, changes };
}

function qualityScore(report) {
  return report.issues.reduce(
    (score, issue) => score + issue.deficit / Math.max(1, issue.threshold || issue.actual),
    0,
  );
}

/**
 * 固定順の候補で、関係を変えずに見栄えだけを直す。
 *
 * 各候補は必ずもう一度 `solve()` し、宣言の関係部分が同一であることも確認する。
 * 通らない候補は採用しないので、修正で「解けるが別の図」へ化ける経路は無い。
 */
export function repairFigure(items) {
  const initialSolved = solve(items);
  const initialQuality = lintFigure(initialSolved);
  const initialPrepared = applyFigureLabelLayout(initialSolved);
  const preparedQuality = lintFigure(initialPrepared);

  if (initialQuality.ok && preparedQuality.ok) {
    return {
      ok: true,
      items,
      solved: initialPrepared,
      quality: preparedQuality,
      initialQuality,
      repaired: false,
      changes: [],
    };
  }

  let best = {
    items,
    solved: initialPrepared,
    quality: preparedQuality,
    changes: ["label_layout"],
  };
  if (preparedQuality.ok) {
    return {
      ok: true,
      ...best,
      initialQuality,
      repaired: true,
    };
  }

  const candidates = [
    combine(items, [(value) => spreadAngles(value, 0)]),
    combine(items, [resampleDistances, (value) => spreadAngles(value, 0)]),
    combine(items, [normalizeAnchors]),
    combine(items, [normalizeAnchors, (value) => spreadAngles(value, 0)]),
    combine(items, [normalizeAnchors, resampleDistances, (value) => spreadAngles(value, 0)]),
    combine(items, [(value) => spreadAngles(value, 43), resampleDistances]),
    combine(items, [(value) => spreadAngles(value, -61), resampleDistances]),
  ].filter(Boolean);
  const seen = new Set();

  for (const candidate of candidates) {
    const key = JSON.stringify(candidate.items);
    if (seen.has(key) || !figureRelationsPreserved(items, candidate.items)) continue;
    seen.add(key);
    try {
      // 修正後は必ず再solveする。ここが、長さラベルなどsolver側の不変量の再検証でもある。
      const solved = applyFigureLabelLayout(solve(candidate.items));
      // 宣言の字面が同じでも、動かした点が直角マークの中身を変えていることがある。
      // 幾何の主張が変わった候補は、たとえ可読性が上がっても採らない。
      if (!declaredAnglesPreserved(items, initialSolved, solved)) continue;
      const quality = lintFigure(solved);
      const current = {
        items: candidate.items,
        solved,
        quality,
        changes: [...candidate.changes, "label_layout"],
      };
      if (qualityScore(quality) < qualityScore(best.quality)) best = current;
      if (quality.ok) {
        return {
          ok: true,
          ...current,
          initialQuality,
          repaired: true,
        };
      }
    } catch {
      // solveに通らない候補は関係を保てていないので、黙って不採用にする。
    }
  }

  return {
    ok: false,
    ...best,
    initialQuality,
    repaired: false,
  };
}
