import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    maxWorkers: 1,
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          testTimeout: 30000,
          include: ["test/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: "factory",
          globalSetup: ["./test/build.ts"],
          root: "./packages/factory",
          include: ["test/**/*.test.ts"],
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: "cli",
          globalSetup: ["./test/build.ts"],
          root: "./packages/cli",
          include: ["test/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
  },
})
