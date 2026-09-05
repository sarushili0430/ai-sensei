/**
 * 「解けるが崩れる」を最小の入力にした回帰fixture。
 *
 * 過去の配送済みitemsは保存されていなかったため、2026-08-19の報告で挙がった
 * 4分類を、同じ不変量を割る最小構成へ正規化して固定する。
 */
export const figureQualityFixtures = [
  {
    id: "dense_points",
    invariant: "point_distance",
    items: [
      { pt: "A", at: [0, 0] },
      { pt: "B", at: [0.05, 0] },
      { pt: "C", at: [4, 3] },
      { poly: ["A", "B", "C"] },
    ],
  },
  {
    id: "overlapping_labels",
    invariant: "label_collision",
    items: [
      { pt: "A", at: [-0.45, 0], showCoord: true },
      { pt: "B", at: [0.45, 0], showCoord: true },
      { pt: "C", at: [0, 8] },
    ],
  },
  {
    id: "flat_triangle",
    invariant: "edge_angle",
    items: [
      { pt: "A", at: [0, 0] },
      { pt: "B", from: "A", dist: 6, deg: 0 },
      { pt: "C", from: "A", dist: 4, deg: 2 },
      { poly: ["A", "B", "C"] },
    ],
  },
  {
    id: "overflowing_label",
    invariant: "viewbox_overflow",
    items: [
      { pt: "A", at: [-1000, 0], showCoord: true },
      { pt: "B", at: [1, 0] },
      { seg: ["A", "B"] },
    ],
  },
];

/** 閾値の偽陽性を守る、10:7へ自然に収まる通常の三角形。 */
export const readableFigureFixture = [
  { pt: "A", at: [0, 4] },
  { pt: "B", at: [-3, -2] },
  { pt: "C", at: [3, -2] },
  { poly: ["A", "B", "C"] },
];
