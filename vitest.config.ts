import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: { label: "pkg", color: "green" },
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.behavior.test.ts"],
        },
      }),
      defineProject({
        test: {
          name: { label: "llm", color: "red" },
          environment: "node",
          include: ["src/**/*.behavior.test.ts"],
          fileParallelism: false,
        },
      }),
    ],
  },
});
