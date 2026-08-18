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

## 考え方

**モデルが書くのは「関係」だけで、座標はこちらが決める。**
一貫していなければならない値 — 長さ・比・符号・矢印・面積・確率・サイコロの目 — を
書かせないので、**食い違った図は作れない**。

- 長さのラベルが実際と違えば落とす(`"6"` と書いた辺が 10 なら通さない)
- 比は `part` で書かせ、`part` どうしの比が実際の長さの比と合うかを見る
- 増減表の符号と矢印は曲線から出す。渡すのは極値の x だけ
- 箱ひげ図の五数要約・散布図の相関係数・正規分布の面積は、データから計算する

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
