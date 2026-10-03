import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          include: ["test/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: "cli",
          root: "./packages/cli",
          include: ["test/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
  },
})
