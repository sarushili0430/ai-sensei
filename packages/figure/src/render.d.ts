import type { Solved } from "./solve.js";

/**
 * 解いた結果 → SVG(黒板に描いた見え方)。
 *
 * これが「サーバで解いて SVG を送る」の中身。端末は受け取った SVG を描くだけで、
 * **語彙が増えても端末側は変わらない**(wireframe D-19/D-21)。
 */
export function render(result: Solved): string;
