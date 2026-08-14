import type { Solved } from "./solve.js";

/**
 * The solved result -> SVG (how it looks drawn on a blackboard).
 *
 * This is what "solve on the server and send SVG" means. The device only draws the
 * SVG it receives, so growing the vocabulary changes nothing on the device
 * (wireframe D-19/D-21).
 */
export function render(result: Solved): string;
