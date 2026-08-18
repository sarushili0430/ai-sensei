# 高校数学の全単元 × 必要な図 × いまの語彙

単元は2022年度からの学習指導要領([文科省](https://www.mext.go.jp/a_menu/shotou/old-cs/1322525.htm))。
「必要な図」は各単元の典型問題を調べて割り出したもの(出典は本文末)。

`○` = いまの語彙で描ける / `△` = 一部だけ / `✗` = 描けない

| 科目 | 単元 | 典型問題で要る図 | 現状 | 足す語彙 |
|---|---|---|---|---|
| **数I** | 数と式 | 数直線(不等式の解・絶対値)、ベン図(集合と命題) | ✗ | `numberLine` `venn` |
| | 図形と計量 | 三角形+辺と角、外接円・内接円、空間図形 | ○ | — |
| | 二次関数 | 放物線・頂点・軸、定義域つき最大最小 | △ | `curve` の定義域制限は既存 |
| | データの分析 | ヒストグラム、箱ひげ図、散布図 | ✗ | `histogram` `boxplot` `scatter` |
| **数A** | 図形の性質 | 五心、チェバ・メネラウス、方べき、接弦、作図 | △ | `bisect` `perpBisect` |
| | 場合の数と確率 | 樹形図、ベン図、表、サイコロ、玉、円順列 | △ | `tree` `venn` |
| | 数学と人間の活動 | 格子点、整数の図 | ✗ | `lattice` |
| **数II** | いろいろな式 | (複素数は数C) | — | — |
| | 図形と方程式 | 円と直線、軌跡、**不等式の表す領域** | ✗ | `region` |
| | 指数・対数関数 | y=a^x / y=log_a x、漸近線 | △ | `asymptote` |
| | 三角関数 | **単位円**、三角関数のグラフ | ✗ | `unitCircle` |
| | 微分・積分の考え | 接線、増減表、面積 | ○ | — |
| **数B** | 数列 | 格子点、群数列の区切り、階差 | ✗ | `lattice` `groups` |
| | 統計的な推測 | 正規分布曲線+斜線部、信頼区間 | ✗ | `normal` |
| | 数学と社会生活 | (グラフ・表の読み取り) | ○ | — |
| **数III** | 極限 | 漸近線、はさみうち | ✗ | `asymptote` |
| | 微分法 | 増減表+**凹凸(f″)**、接線・法線 | △ | `signTable` に凹凸 |
| | 積分法 | 面積、回転体、**区分求積の短冊**、曲線の長さ | △ | `riemann` |
| **数C** | ベクトル | **矢印(有向線分)**、内分、空間ベクトル | ✗ | `vec` |
| | 平面上の曲線と複素数平面 | 楕円・双曲線・放物線の**焦点/準線/漸近線**、極座標、**複素数平面** | ✗ | `conic` `polar` `complexPlane` |
| | 数学的な表現の工夫 | (図表全般) | ○ | — |

## 足りない語彙 18 個

優先順は「その単元で図が無いと説明が成り立たないか」で並べた。

1. `unitCircle` — 三角方程式・不等式は単位円で説明するのが定石
2. `vec` — ベクトルは矢印そのもの
3. `numberLine` — 不等式・絶対値。いちばん基本の図
4. `region` — 不等式の表す領域(半平面・円の内外・連立)
5. `boxplot` `histogram` `scatter` — データの分析は単元まるごと図
6. `tree` — 樹形図
7. `venn` — 集合・命題・確率
8. `lattice` — 格子点
9. `normal` — 正規分布曲線と斜線部
10. `conic` — 2次曲線の焦点・準線・漸近線
11. `complexPlane` — 複素数平面
12. `polar` — 極方程式
13. `asymptote` — 漸近線
14. `riemann` — 区分求積の短冊
15. `signTable` に凹凸(f″)
16. `bisect` `perpBisect` — 角の二等分線・垂直二等分線
17. `groups` — 群数列の区切り

## 足す条件(D-19)

**機械で検算できる不変量が1本書けること。** 書けないものは足さない。

| 語彙 | 不変量 |
|---|---|
| `unitCircle` | 印をつけた点が (cos θ, sin θ) と一致する |
| `vec` | 矢印の始点・終点が名前つきの点と一致する |
| `numberLine` | 塗った区間の端が解と一致し、白丸/黒丸が不等号と合う |
| `region` | 標本点を内外に分類した結果が式と合う |
| `boxplot` | 五数要約が**データから計算した値**と一致する |
| `histogram` | 各階級の度数がデータの数え上げと一致する |
| `scatter` | 相関係数がデータから計算した値と一致する |
| `tree` | 葉の数が場合の数と一致する |
| `venn` | 各領域の個数の合計が全体と一致する |
| `lattice` | 条件を満たす格子点の個数が数え上げと一致する |
| `normal` | 斜線部の面積が確率と一致する |
| `conic` | c² = a² ∓ b²、焦点・漸近線が標準形と一致する |
| `complexPlane` | 回転・拡大した点が計算値と一致する |
| `polar` | 曲線上の点が r = f(θ) を満たす |
| `riemann` | 短冊の本数と面積の和が区分求積の値と一致する |
| `signTable`(凹凸) | 変曲点で f″ = 0、区間の凹凸が f″ の符号と一致する |
| `bisect` | 二等分線上の点が2辺から等距離 / 角が等しい |

**どれも「モデルが書いた数字」ではなく「こちらが計算した値」と突き合わせる。**
モデルに書かせるのは、データ・式・条件だけ。

## 出典

- [第4節 数学(文部科学省)](https://www.mext.go.jp/a_menu/shotou/old-cs/1322525.htm)
- [数学A 図形の性質(受験の月)](https://examist.jp/mathematics/plane-figure/ceva-menelaus/)
- [数学II 軌跡と領域(受験の月)](https://examist.jp/category/mathematics/locus-area/)
- [数学C 2次曲線(受験の月)](https://examist.jp/category/mathematics/quadratic-curve/)
- [数学III 積分法の応用(受験の月)](https://examist.jp/category/mathematics/sum-volume-length1/)
- [数学C 位置ベクトル(受験の月)](https://examist.jp/mathematics/planar-vector/bunten-itivector/)
- [高等学校数学I/データの分析(Wikibooks)](https://ja.wikibooks.org/wiki/%E9%AB%98%E7%AD%89%E5%AD%A6%E6%A0%A1%E6%95%B0%E5%AD%A6I/%E3%83%87%E3%83%BC%E3%82%BF%E3%81%AE%E5%88%86%E6%9E%90)
- [高等学校数学A/場合の数と確率(Wikibooks)](https://ja.wikibooks.org/wiki/%E9%AB%98%E7%AD%89%E5%AD%A6%E6%A0%A1%E6%95%B0%E5%AD%A6A/%E5%A0%B4%E5%90%88%E3%81%AE%E6%95%B0%E3%81%A8%E7%A2%BA%E7%8E%87)
- [数学B 統計的な推測(数学の時間)](https://akiyamath.com/2023/10/statistics_in_high-school/)
- [三角不等式と単位円(linky塾)](https://linky-juku.com/trigonometric-inequality/)
- [命題の真偽と集合の包含関係(受験の月)](https://examist.jp/mathematics/class/meidai-syuugou/)
