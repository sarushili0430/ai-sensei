# Every high-school maths unit x the figure it needs x today's vocabulary

The units follow the national guidelines in force from 2022
([MEXT](https://www.mext.go.jp/a_menu/shotou/old-cs/1322525.htm)).
"The figure it needs" was worked out by surveying each unit's typical problems (sources
at the end).

`○` = drawable with today's vocabulary / `△` = partly / `✗` = not drawable

| Course | Unit | Figure needed by typical problems | Status | Vocabulary to add |
|---|---|---|---|---|
| **Math I** | Numbers and expressions | Number line (inequality solutions, absolute value), Venn diagram (sets and propositions) | ✗ | `numberLine` `venn` |
| | Geometry and measurement | Triangle with sides and angles, circumscribed and inscribed circles, solids | ○ | — |
| | Quadratic functions | Parabola, vertex, axis; max/min on a restricted domain | △ | `curve`'s domain restriction already exists |
| | Data analysis | Histogram, box plot, scatter plot | ✗ | `histogram` `boxplot` `scatter` |
| **Math A** | Properties of figures | The five centres, Ceva and Menelaus, power of a point, tangent-chord, constructions | △ | `bisect` `perpBisect` |
| | Counting and probability | Tree diagram, Venn diagram, tables, dice, balls, circular permutations | △ | `tree` `venn` |
| | Mathematics and human activity | Lattice points, integer diagrams | ✗ | `lattice` |
| **Math II** | Various expressions | (complex numbers are in Math C) | — | — |
| | Figures and equations | Lines and circles, loci, **regions defined by inequalities** | ✗ | `region` |
| | Exponential and log functions | y=a^x / y=log_a x, asymptotes | △ | `asymptote` |
| | Trigonometric functions | **The unit circle**, graphs of trigonometric functions | ✗ | `unitCircle` |
| | Ideas of differentiation and integration | Tangents, sign tables, areas | ○ | — |
| **Math B** | Sequences | Lattice points, group-sequence boundaries, differences | ✗ | `lattice` `groups` |
| | Statistical inference | The normal curve with a shaded region, confidence intervals | ✗ | `normal` |
| | Mathematics and social life | (reading graphs and tables) | ○ | — |
| **Math III** | Limits | Asymptotes, the squeeze theorem | ✗ | `asymptote` |
| | Differentiation | Sign table plus **concavity (f'')**, tangents and normals | △ | concavity in `signTable` |
| | Integration | Areas, solids of revolution, **Riemann rectangles**, arc length | △ | `riemann` |
| **Math C** | Vectors | **Arrows (directed segments)**, internal division, 3D vectors | ✗ | `vec` |
| | Plane curves and the complex plane | **Foci / directrices / asymptotes** of ellipses, hyperbolas and parabolas; polar coordinates; **the complex plane** | ✗ | `conic` `polar` `complexPlane` |
| | Devices of mathematical expression | (diagrams generally) | ○ | — |

## The 18 missing vocabulary items

Ordered by "does the explanation fall apart without the figure in that unit".

1. `unitCircle` — trigonometric equations and inequalities are standardly explained on the unit circle
2. `vec` — a vector *is* an arrow
3. `numberLine` — inequalities and absolute values. The most basic figure of all
4. `region` — the region an inequality defines (half-planes, circle interiors, systems)
5. `boxplot` `histogram` `scatter` — data analysis is an entire unit of figures
6. `tree` — tree diagrams
7. `venn` — sets, propositions, probability
8. `lattice` — lattice points
9. `normal` — the normal curve and its shaded region
10. `conic` — a conic's foci, directrix and asymptotes
11. `complexPlane` — the complex plane
12. `polar` — polar equations
13. `asymptote` — asymptotes
14. `riemann` — Riemann rectangles
15. Concavity (f'') in `signTable`
16. `bisect` `perpBisect` — angle bisectors and perpendicular bisectors
17. `groups` — group-sequence boundaries

## The condition for adding one (D-19)

**You can write one machine-checkable invariant.** If you cannot, do not add it.

| Vocabulary | Invariant |
|---|---|
| `unitCircle` | The marked point equals (cos θ, sin θ) |
| `vec` | The arrow's start and end match named points |
| `numberLine` | The shaded interval's ends match the solution, and open/closed circles match the inequality |
| `region` | Classifying sample points as inside/outside matches the expression |
| `boxplot` | The five-number summary matches **the value computed from the data** |
| `histogram` | Each class's frequency matches the count from the data |
| `scatter` | The correlation coefficient matches the value computed from the data |
| `tree` | The number of leaves matches the count of cases |
| `venn` | The region counts sum to the whole |
| `lattice` | The number of lattice points satisfying the condition matches the count |
| `normal` | The shaded area matches the probability |
| `conic` | c² = a² ∓ b², and the foci and asymptotes match the standard form |
| `complexPlane` | A rotated or scaled point matches the computed value |
| `polar` | Points on the curve satisfy r = f(θ) |
| `riemann` | The rectangle count and the area sum match the Riemann value |
| `signTable` (concavity) | f'' = 0 at the inflection point, and each interval's concavity matches the sign of f'' |
| `bisect` | A point on the bisector is equidistant from the two sides / the angles are equal |

**Every one of them compares against a value *we* computed, never a number the model
wrote.** The model writes only the data, the expression and the condition.

## Sources

- [Section 4, Mathematics (MEXT)](https://www.mext.go.jp/a_menu/shotou/old-cs/1322525.htm)
- [Math A, properties of figures (Juken no Tsuki)](https://examist.jp/mathematics/plane-figure/ceva-menelaus/)
- [Math II, loci and regions (Juken no Tsuki)](https://examist.jp/category/mathematics/locus-area/)
- [Math C, conics (Juken no Tsuki)](https://examist.jp/category/mathematics/quadratic-curve/)
- [Math III, applications of integration (Juken no Tsuki)](https://examist.jp/category/mathematics/sum-volume-length1/)
- [Math C, position vectors (Juken no Tsuki)](https://examist.jp/mathematics/planar-vector/bunten-itivector/)
- [High-school Math I / data analysis (Wikibooks)](https://ja.wikibooks.org/wiki/%E9%AB%98%E7%AD%89%E5%AD%A6%E6%A0%A1%E6%95%B0%E5%AD%A6I/%E3%83%87%E3%83%BC%E3%82%BF%E3%81%AE%E5%88%86%E6%9E%90)
- [High-school Math A / counting and probability (Wikibooks)](https://ja.wikibooks.org/wiki/%E9%AB%98%E7%AD%89%E5%AD%A6%E6%A0%A1%E6%95%B0%E5%AD%A6A/%E5%A0%B4%E5%90%88%E3%81%AE%E6%95%B0%E3%81%A8%E7%A2%BA%E7%8E%87)
- [Math B, statistical inference (Sugaku no Jikan)](https://akiyamath.com/2023/10/statistics_in_high-school/)
- [Trigonometric inequalities and the unit circle (linky juku)](https://linky-juku.com/trigonometric-inequality/)
- [Truth of propositions and set inclusion (Juken no Tsuki)](https://examist.jp/mathematics/class/meidai-syuugou/)
