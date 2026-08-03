import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "scripts/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "backend/*/src/**/*.test.ts",
      "backend/*/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/mobile/**"],
  },
});
