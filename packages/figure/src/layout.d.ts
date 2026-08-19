import type { Pt, Solved } from "./solve.js";

export const figureViewBoxWidth: 320;
export const figureViewBoxHeight: 224;
export const figureHorizontalMargin: 30;
export const figureVerticalMargin: 21;

export type FigureClip = { x0: number; x1: number; y0: number; y1: number };
export type FigureBounds = FigureClip & { clip: FigureClip | null };

export type FigureLayout = {
  width: number;
  height: number;
  scale: number;
  rawBounds: FigureBounds;
  fittedBounds: FigureClip;
  clip: FigureClip | null;
  x(value: number): number;
  y(value: number): number;
};

export function hasSpecialLayout(result: Solved): boolean;
export function figureClip(result: Solved): FigureClip | null;
export function isInsideFigureClip(point: Pt, clip: FigureClip | null): boolean;
export function figureGeometryBounds(result: Solved): FigureBounds;
export function createFigureLayout(result: Solved): FigureLayout;
