import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  { ignores: ["dist", "test-results", "playwright-report", "e2e/screenshots"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "detect" } },
    plugins: { react, "react-hooks": reactHooks },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs["recommended-latest"].rules,
      // Plain JavaScript project: props aren't typed with PropTypes.
      "react/prop-types": "off",
      // Apostrophes in JSX text are fine; keep catching the characters that are typos.
      "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // Node-side files: tooling config, Playwright tests and their mock API server.
    files: ["*.config.js", "e2e/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
