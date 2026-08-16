import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Formatting is owned by the editor's formatter, so this config carries no
// stylistic rules: only correctness and dead-code checks.
export default tseslint.config(
  {
    ignores: ["out/**", "release/**", "coverage/**", "node_modules/**", "site/**", ".e2e/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Build scripts and config files run on Node and are never type-checked.
  // The e2e scripts also embed page.evaluate bodies, so they see DOM globals.
  {
    files: ["scripts/**/*.mjs", "*.config.js", "*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
