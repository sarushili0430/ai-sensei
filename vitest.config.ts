import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "scripts/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "backend/*/src/**/*.test.ts",
      "backend/*/test/**/*.test.ts",
      // apps/tuner はブラウザ用の素のJS。実機と答えが違ってはいけない部分
      // (板書の欠落判定・plotの式評価)だけをここで見る。
      "apps/tuner/test/**/*.test.js",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/mobile/**"],
  },
});
