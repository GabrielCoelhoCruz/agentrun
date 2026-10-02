import { defineConfig } from "oxlint"

// Oxlint parses TypeScript 7 without the unsupported typescript-eslint API.
export default defineConfig({
  ignorePatterns: ["node_modules/**", "**/dist/**", "**/build/**", "spikes/**"],
  plugins: ["typescript", "oxc"],
  jsPlugins: [{ name: "@effect", specifier: "@effect/eslint-plugin" }],
  categories: {
    correctness: "error",
  },
  rules: {
    "@effect/dprint": ["error", {
      config: {
        indentWidth: 2,
        semiColons: "asi",
        quoteStyle: "alwaysDouble",
        trailingCommas: "onlyMultiLine",
      },
    }],
  },
})
