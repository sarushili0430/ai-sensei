/**
 * 板書の1要素を描く。`packages/contract/src/board.ts` の `boardElementSchema` の
 * 8つの枝(latex / text / plot / triangle / circle / sentence / compare / figure)に対応する。
 *
 * **見た目をアプリと1pxまで合わせにいかない。** ここで見たいのは
 * 「先輩が何を書いたか」であって、実機の描画品質ではない
 * (それは `apps/mobile` の golden test の担当)。合わせてあるのは
 * **中身の解釈**だけ — 座標系(y上向き)・図の縦横比・不連続での線の切りかた。
 *
 * `figure` の SVG は `<img>` で出す。文字列をそのままDOMへ入れると、
 * 板書の経路が **任意のマークアップを画面に流し込む口**になる
 * (SVGは `<script>` を持てる)。`<img>` の中ではスクリプトは動かない。
 */
import katex from "/vendor/katex/katex.mjs";
import { parsePlotExpression } from "./plot.js";

/** 図の描画サイズ(CSSピクセル)。板書1行として読める大きさ。 */
const FIGURE_WIDTH = 460;
const FIGURE_HEIGHT = 260;
const PLOT_SAMPLES = 240;

const SVG_NS = "http://www.w3.org/2000/svg";

/** 手順1つ(`speech` + 板書要素)を `<li>` にする。 */
export function renderStep(step) {
  const item = document.createElement("li");
  item.className = "step";

  const head = document.createElement("div");
  head.className = "step-head";
  head.append(badge(`#${step.index}`));
  if (step.awaits_student) head.append(badge("生徒の番", "awaits"));
  if (!step.board) head.append(badge("音声のみ", "muted"));
  item.append(head);

  const speech = document.createElement("p");
  speech.className = "step-speech";
  speech.textContent = step.speech;
  // 音声の上限(120字)にどれだけ近いかは、そのままTTSの原価に直結する。
  speech.dataset["length"] = `${[...step.speech].length}字`;
  item.append(speech);

  if (step.board) item.append(renderElement(step.board));
  return item;
}

function badge(text, kind) {
  const span = document.createElement("span");
  span.className = kind ? `badge badge-${kind}` : "badge";
  span.textContent = text;
  return span;
}

/** 板書要素1つ。描けないものは黙って消さず、理由を出す。 */
export function renderElement(element) {
  const box = document.createElement("div");
  box.className = `element element-${element.kind}`;
  try {
    box.append(build(element));
  } catch (error) {
    box.append(failure(`${element.kind} を描けません: ${String(error)}`));
  }
  return box;
}

function build(element) {
  switch (element.kind) {
    case "latex":
      return latexNode(element.tex);
    case "text":
      return textNode(element.body);
    case "plot":
      return plotNode(element);
    case "triangle":
      return triangleNode(element);
    case "circle":
      return circleNode(element);
    case "sentence":
      return sentenceNode(element);
    case "compare":
      return compareNode(element);
    case "figure":
      return figureNode(element);
    default:
      return failure(`知らない kind です: ${String(element.kind)}`);
  }
}

function failure(message) {
  const node = document.createElement("p");
  node.className = "element-error";
  node.textContent = message;
  return node;
}

function latexNode(tex) {
  const node = document.createElement("div");
  node.className = "latex";
  // throwOnError: false にすると壊れた式が赤字で出る。**それが見たい**
  // (描けない式を先輩が書いたことは、プロンプト側の問題として観測したい)。
  node.innerHTML = katex.renderToString(tex, { throwOnError: false, displayMode: true });
  return node;
}

function textNode(body) {
  const node = document.createElement("p");
  node.className = "board-text";
  node.textContent = body;
  return node;
}

function sentenceNode(element) {
  const node = document.createElement("div");
  node.className = "sentence";

  const line = document.createElement("p");
  line.className = "sentence-text";
  const focus = element.focus;
  const at = focus ? element.text.indexOf(focus) : -1;
  if (at >= 0) {
    // `focus` は `text` の部分文字列であること(JSON Schemaに書けない不変条件)。
    // 見つからないときは下線を引かない = そのまま画面に出る形で気づける。
    line.append(element.text.slice(0, at));
    const mark = document.createElement("u");
    mark.textContent = focus;
    line.append(mark, element.text.slice(at + focus.length));
  } else {
    line.textContent = element.text;
    if (focus) line.dataset["warning"] = `focus が本文にありません: ${focus}`;
  }
  node.append(line);

  if (element.gloss) {
    const gloss = document.createElement("p");
    gloss.className = "sentence-gloss";
    gloss.textContent = element.gloss;
    node.append(gloss);
  }
  return node;
}

function compareNode(element) {
  const table = document.createElement("table");
  table.className = "compare";
  if (element.title) {
    const caption = document.createElement("caption");
    caption.textContent = element.title;
    table.append(caption);
  }
  const head = table.createTHead().insertRow();
  for (const column of element.columns) {
    const cell = document.createElement("th");
    cell.textContent = column;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of element.rows) {
    const line = body.insertRow();
    for (const cell of row) line.insertCell().textContent = cell;
  }
  return table;
}

function figureNode(element) {
  if (!element.svg) {
    // agent が `@ai-sensei/figure` で解いて詰める欄。空で届いたら、
    // 解けなかったか、詰め忘れている。**items だけでも見えるようにする。**
    const fallback = document.createElement("pre");
    fallback.className = "element-error";
    fallback.textContent = `svg がありません。items:\n${JSON.stringify(element.items, null, 2)}`;
    return fallback;
  }
  const image = document.createElement("img");
  image.className = "figure";
  image.alt = element.alt ?? "作図";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(element.svg)}`;
  return image;
}

/* -------------------------------------------------------------------------- */
/* 図形(数学座標 → SVG座標)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 数学の座標(y上向き)を SVG のピクセル座標(y下向き)に変える。
 * `apps/mobile` の `BoardCoordinateSpace` と同じ計算。
 */
function coordinateSpace({ minX, maxX, minY, maxY, preserveAspectRatio = true, padding = 24 }) {
  const dataWidth = Math.max(maxX - minX, 1e-9);
  const dataHeight = Math.max(maxY - minY, 1e-9);
  let scaleX = Math.max(FIGURE_WIDTH - padding * 2, 1) / dataWidth;
  let scaleY = Math.max(FIGURE_HEIGHT - padding * 2, 1) / dataHeight;
  if (preserveAspectRatio) {
    // 円が楕円に、直角が直角に見えなくなるのを防ぐ。
    const uniform = Math.min(scaleX, scaleY);
    scaleX = uniform;
    scaleY = uniform;
  }
  const originX = FIGURE_WIDTH / 2 - ((minX + maxX) / 2) * scaleX;
  const originY = FIGURE_HEIGHT / 2 + ((minY + maxY) / 2) * scaleY;
  return {
    scale: scaleX,
    at: (x, y) => [originX + x * scaleX, originY - y * scaleY],
  };
}

function svgRoot() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`);
  svg.setAttribute("width", String(FIGURE_WIDTH));
  svg.setAttribute("height", String(FIGURE_HEIGHT));
  svg.classList.add("board-svg");
  return svg;
}

function shape(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function label(text, [x, y]) {
  const node = shape("text", { x, y, "text-anchor": "middle", "dominant-baseline": "middle" });
  node.textContent = text;
  node.classList.add("board-svg-label");
  return node;
}

function plotNode(element) {
  const evaluate = parsePlotExpression(element.fn);
  const { min, max } = element.domain;
  if (!(min < max)) throw new Error("domain は min < max");

  const xs = [];
  const ys = [];
  for (let index = 0; index <= PLOT_SAMPLES; index += 1) {
    const x = min + ((max - min) * index) / PLOT_SAMPLES;
    xs.push(x);
    let y;
    try {
      y = evaluate(x);
    } catch {
      y = Number.NaN;
    }
    ys.push(y);
  }

  const marks = element.marks ?? [];
  const finite = ys.filter((y) => Number.isFinite(y));
  if (finite.length === 0) throw new Error("定義域内に描ける点がありません");
  let minY = Math.min(...finite, ...marks.map((mark) => mark.at.y));
  let maxY = Math.max(...finite, ...marks.map((mark) => mark.at.y));
  if (Math.abs(maxY - minY) < 1e-9) {
    minY -= 1;
    maxY += 1;
  }

  const space = coordinateSpace({
    minX: min,
    maxX: max,
    minY,
    maxY,
    preserveAspectRatio: false,
  });
  const svg = svgRoot();

  // 軸(0を含むときだけ)。
  if (minY <= 0 && maxY >= 0) {
    const [x1, y1] = space.at(min, 0);
    const [x2, y2] = space.at(max, 0);
    svg.append(shape("line", { x1, y1, x2, y2, class: "board-svg-axis" }));
  }
  if (min <= 0 && max >= 0) {
    const [x1, y1] = space.at(0, maxY);
    const [x2, y2] = space.at(0, minY);
    svg.append(shape("line", { x1, y1, x2, y2, class: "board-svg-axis" }));
  }

  // 定義域外(NaN)と不連続で線を切る。切らないと、漸近線をまたいで
  // 「つながっている」という数学的に嘘の線が引かれる。
  const span = maxY - minY;
  let points = [];
  let previous = null;
  const flush = () => {
    if (points.length > 1) {
      svg.append(shape("polyline", { points: points.join(" "), class: "board-svg-curve" }));
    }
    points = [];
  };
  for (let index = 0; index <= PLOT_SAMPLES; index += 1) {
    const y = ys[index];
    const jumped = previous !== null && Math.abs(previous - y) > span * 0.5;
    if (!Number.isFinite(y) || jumped) {
      flush();
      previous = Number.isFinite(y) ? y : null;
      if (!Number.isFinite(y)) continue;
    }
    const [px, py] = space.at(xs[index], y);
    points.push(`${px.toFixed(2)},${py.toFixed(2)}`);
    previous = y;
  }
  flush();

  for (const mark of marks) {
    const [cx, cy] = space.at(mark.at.x, mark.at.y);
    svg.append(shape("circle", { cx, cy, r: 4, class: "board-svg-mark" }));
    if (mark.label) svg.append(label(mark.label, [cx, cy - 14]));
  }
  return svg;
}

function triangleNode(element) {
  const [a, b, c] = element.vertices;
  const space = coordinateSpace({
    minX: Math.min(a.x, b.x, c.x),
    maxX: Math.max(a.x, b.x, c.x),
    minY: Math.min(a.y, b.y, c.y),
    maxY: Math.max(a.y, b.y, c.y),
  });
  const svg = svgRoot();
  const points = element.vertices.map((vertex) => space.at(vertex.x, vertex.y));
  svg.append(
    shape("polygon", {
      points: points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "),
      class: "board-svg-figure",
    }),
  );

  const center = [
    points.reduce((sum, [x]) => sum + x, 0) / 3,
    points.reduce((sum, [, y]) => sum + y, 0) / 3,
  ];
  for (const [index, text] of (element.labels ?? []).entries()) {
    const [x, y] = points[index];
    // 重心と反対側へ少し逃がす(辺の上に頂点名が乗らないように)。
    const dx = x - center[0];
    const dy = y - center[1];
    const length = Math.hypot(dx, dy) || 1;
    svg.append(label(text, [x + (dx / length) * 16, y + (dy / length) * 16]));
  }

  for (const mark of element.marks ?? []) {
    const [x, y] = points[mark.vertex];
    const dx = center[0] - x;
    const dy = center[1] - y;
    const length = Math.hypot(dx, dy) || 1;
    const inward = [x + (dx / length) * 18, y + (dy / length) * 18];
    svg.append(
      shape("circle", {
        cx: inward[0],
        cy: inward[1],
        r: mark.kind === "right_angle" ? 5 : 9,
        class: mark.kind === "right_angle" ? "board-svg-right-angle" : "board-svg-angle",
      }),
    );
    if (mark.label) svg.append(label(mark.label, [inward[0], inward[1] - 16]));
  }
  return svg;
}

function circleNode(element) {
  const { center, r } = element;
  const space = coordinateSpace({
    minX: center.x - r,
    maxX: center.x + r,
    minY: center.y - r,
    maxY: center.y + r,
  });
  const svg = svgRoot();
  const [cx, cy] = space.at(center.x, center.y);
  svg.append(shape("circle", { cx, cy, r: r * space.scale, class: "board-svg-figure" }));
  svg.append(shape("circle", { cx, cy, r: 3, class: "board-svg-mark" }));
  for (const [index, text] of (element.labels ?? []).entries()) {
    svg.append(label(text, [cx, cy - r * space.scale - 12 - index * 16]));
  }
  return svg;
}
