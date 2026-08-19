import type { Item, Solved } from "./solve.js";

export const figureMinPointDistancePx: 16;
export const figureMinEdgeAngleDeg: 12;
export const figureLabelGapPx: 2;
export const figureMaxOverflowPx: 1;

export type FigureQualityInvariant =
  | "point_distance"
  | "edge_angle"
  | "label_collision"
  | "viewbox_overflow";

export type FigureQualityIssue = {
  invariant: FigureQualityInvariant;
  actual: number;
  threshold: number;
  deficit: number;
  unit: "px" | "deg" | "px2";
  entities: string[];
  message: string;
};

export type FigureQualityReport = {
  ok: boolean;
  issues: FigureQualityIssue[];
  metrics: {
    minPointDistancePx: number | null;
    minEdgeAngleDeg: number | null;
    labelCollisionCount: number;
    maxLabelOverlapPx2: number;
    maxOverflowPx: number;
  };
};

export type FigureRepairResult =
  | {
      ok: true;
      items: Item[];
      solved: Solved;
      quality: FigureQualityReport;
      initialQuality: FigureQualityReport;
      repaired: boolean;
      changes: string[];
    }
  | {
      ok: false;
      items: Item[];
      solved: Solved;
      quality: FigureQualityReport;
      initialQuality: FigureQualityReport;
      repaired: false;
      changes: string[];
    };

export function lintFigure(result: Solved): FigureQualityReport;
export function applyFigureLabelLayout(result: Solved): Solved;
export function figureRelationsPreserved(original: Item[], candidate: Item[]): boolean;
export function repairFigure(items: Item[]): FigureRepairResult;
