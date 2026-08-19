# @ai-sensei/figure

作図の宣言(JSON)を座標に解き、SVG にする。

```ts
import { drawFigure } from "@ai-sensei/figure";

const r = drawFigure([
  { pt: "A", at: [0, 0] },
  { pt: "B", from: "A", dist: 6, deg: -20 },
  { pt: "C", from: "A", dist: 4, deg: -70 },
  { line: "L", bisect: ["B", "A", "C"] },
  { pt: "D", meet: ["L", ["B", "C"]] },   // BD:DC = 6:4 が、指定せずに出る
]);
r.ok ? r.svg : r.errors;
```

`drawFigure()` は solve 後に可読性lintを通す。点間距離・辺の最小角・ラベル衝突・
320×224 viewBox からのはみ出しを測り、崩れていれば関係を保ったまま固定順の候補で
`at` / 点配置用 `deg` / 見栄え用 `dist` とラベル方角を直す。各候補は再度 `solve()` し、
関係宣言が同一であることも検算してから採用する。

純関数だけを個別に使うこともできる:

```ts
const solved = solve(items);
const report = lintFigure(solved); // invariant / actual / threshold / deficit
const repaired = repairFigure(items); // 同じ入力なら同じ候補・同じ結果
```

閾値は `quality.js`、320×224への座標変換と正規化した余白は `layout.js` が正。
品質検査とレンダラが同じ変換を使うので、lintとSVGで内外判定がずれない。

## 考え方

**モデルが書くのは「関係」だけで、座標はこちらが決める。**
一貫していなければならない値 — 長さ・比・符号・矢印・面積・確率・サイコロの目 — を
書かせないので、**食い違った図は作れない**。

- 長さのラベルが実際と違えば落とす(`"6"` と書いた辺が 10 なら通さない)
- 比は `part` で書かせ、`part` どうしの比が実際の長さの比と合うかを見る
- 増減表の符号と矢印は曲線から出す。渡すのは極値の x だけ
- 箱ひげ図の五数要約・散布図の相関係数・正規分布の面積は、データから計算する
- ラベルは点の8方位、線の両側から空いている候補を決定的に選ぶ
- 極端な縦横比は短い側の仮想範囲を広げ、円と角度を歪めず10:7へ収める

## なぜ `solve.js` / `render.js` だけ JS なのか

**意図的**。ここは「知らない形の JSON を受け取り、駄目なら投げる」コードで、
安全は実行時の検査(`schema.ts` と `solve()` 自身の throw)が担っている。
`noUncheckedIndexedAccess` の下で書き直すと `!` が100個増えるだけで、
**実測240回で通っているコードに、測っていない変更を入れる**ことになる。

型は外から見える形に付けてある(`solve.d.ts` / `render.d.ts` / `schema.ts`)。
振る舞いは実測の出力で固定してある:

```
node --experimental-strip-types docs/figeval/verify-port.mjs    # 移植でこわれていないか
node --experimental-strip-types docs/figeval/verify-schema.mjs  # 契約が実測を弾かないか
```

## 語彙を足すとき

条件は1つ、**機械で検算できる不変量が1本書けること**。
手順と実測は `docs/figeval/README.md`、単元との対応は `docs/figeval/units.md`。
`figureKeys` にキーを足し忘れると丸ごと通らなくなるので、`verify-schema.mjs` を必ず回す
(実際 `conic` の `a`/`b` を書き忘れて、これで見つけた)。
