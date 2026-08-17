/**
 * `plot.fn` の評価器。
 *
 * 文法は `packages/contract/src/board.ts` の `plotFunctionPattern` と同じ範囲
 * (変数x・数値・四則・累乗・括弧・`sin`/`cos`/`tan`/`sqrt`/`abs`/`log`/`ln`/`exp`/`pi`)。
 * アプリ側の `plot_expression.dart` と**同じ解釈**にしてある —
 * `log` は常用対数(底10)、`ln` は自然対数。
 *
 * **`eval` や `new Function` を使わないこと。** LLMが書いた文字列を実行する経路を
 * 作ることになり、「LLMにはパラメータだけ吐かせる」(計画書 §3-3)がこの画面だけ破れる。
 */

const FUNCTIONS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
};

/** 式を関数に変える。文法から外れていたら `Error` を投げる(呼び出し側が描画をあきらめる)。 */
export function parsePlotExpression(source) {
  const tokens = tokenize(source);
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (type) => {
    const token = next();
    if (token.type !== type) throw new Error(`plotの式が読めません(${type} を期待)`);
    return token;
  };

  /** 加減。 */
  const parseExpression = () => {
    let node = parseTerm();
    for (;;) {
      const token = peek();
      if (token.type !== "+" && token.type !== "-") return node;
      next();
      const right = parseTerm();
      node = token.type === "+" ? add(node, right) : subtract(node, right);
    }
  };

  /** 乗除。 */
  const parseTerm = () => {
    let node = parseUnary();
    for (;;) {
      const token = peek();
      if (token.type !== "*" && token.type !== "/") return node;
      next();
      const right = parseUnary();
      node = token.type === "*" ? multiply(node, right) : divide(node, right);
    }
  };

  const parseUnary = () => {
    const token = peek();
    if (token.type === "-") {
      next();
      const operand = parseUnary();
      return (x) => -operand(x);
    }
    if (token.type === "+") {
      next();
      return parseUnary();
    }
    return parsePower();
  };

  /** 累乗は右結合(2^3^2 = 2^9)。指数側に単項マイナスを許す(x^-2)。 */
  const parsePower = () => {
    const base = parsePrimary();
    if (peek().type !== "^") return base;
    next();
    const exponent = parseUnary();
    return (x) => base(x) ** exponent(x);
  };

  const parsePrimary = () => {
    const token = next();
    if (token.type === "number") return () => token.value;
    if (token.type === "(") {
      const inner = parseExpression();
      expect(")");
      return inner;
    }
    if (token.type === "ident") {
      if (token.text === "x") return (x) => x;
      if (token.text === "pi") return () => Math.PI;
      const fn = FUNCTIONS[token.text];
      if (!fn) throw new Error(`plotの式に使えない名前です: ${token.text}`);
      expect("(");
      const argument = parseExpression();
      expect(")");
      return (x) => fn(argument(x));
    }
    throw new Error("plotの式が読めません");
  };

  const root = parseExpression();
  if (peek().type !== "end") throw new Error("plotの式に余りがあります");
  return root;
}

const add = (a, b) => (x) => a(x) + b(x);
const subtract = (a, b) => (x) => a(x) - b(x);
const multiply = (a, b) => (x) => a(x) * b(x);
const divide = (a, b) => (x) => a(x) / b(x);

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
    } else if (/[0-9.]/.test(character)) {
      const start = index;
      let sawDot = false;
      while (
        index < source.length &&
        (/[0-9]/.test(source[index]) || (source[index] === "." && !sawDot))
      ) {
        if (source[index] === ".") sawDot = true;
        index += 1;
      }
      tokens.push({ type: "number", value: Number.parseFloat(source.slice(start, index)) });
    } else if (/[a-zA-Z]/.test(character)) {
      const start = index;
      while (index < source.length && /[a-zA-Z]/.test(source[index])) index += 1;
      tokens.push({ type: "ident", text: source.slice(start, index) });
    } else if ("+-*/^(),".includes(character)) {
      tokens.push({ type: character });
      index += 1;
    } else {
      throw new Error(`plotの式に使えない文字です: "${character}"`);
    }
  }
  tokens.push({ type: "end" });
  return tokens;
}
