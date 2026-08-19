import type { FigureQualityInvariant } from "./quality.js";
import type { Item } from "./solve.js";

export const figureQualityFixtures: Array<{
  id: string;
  invariant: FigureQualityInvariant;
  items: Item[];
}>;
export const readableFigureFixture: Item[];
