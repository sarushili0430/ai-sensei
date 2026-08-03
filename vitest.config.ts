import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "scripts/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "workers/*/src/**/*.test.ts",
      "workers/*/test/**/*.test.ts",
      "agent/src/**/*.test.ts",
      "agent/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/mobile/**"],
  },
});
