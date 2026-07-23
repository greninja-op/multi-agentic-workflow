// Flat ESLint config (ESLint 9+) for the collaborative-file-lock-sync monorepo.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // Never lint build output, deps, or the VS Code extension bundle.
    ignores: [
      "**/dist/**",
      "apps/cli/dist-exe/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "coverage/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      // TypeScript source and tests run under Node (the extension host is Node
      // too); declare Node globals so `no-undef` does not flag console/process/
      // Buffer/timers that the type checker already validates.
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Node scripts, tooling, and the demo runners are ESM modules run by Node.
    files: ["**/*.mjs", "**/*.cjs", "**/scripts/**/*.js", "tools/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // The static dashboard/site client runs in the browser.
    files: ["website/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
  // Keep ESLint out of Prettier's way (formatting is Prettier's job).
  prettier,
);
