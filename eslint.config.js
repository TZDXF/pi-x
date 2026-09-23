import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      ".playwright-cli/**",
      // Vendored component libraries (shadcn-vue / ai-elements) — maintained upstream.
      "src/components/ui/**",
      "src/components/ai-elements/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // `essential` = correctness rules only; stylistic Vue formatting is left to
  // the existing codebase conventions instead of a mass reformat.
  ...pluginVue.configs["flat/essential"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, sourceType: "module" },
    },
  },
  {
    files: ["tests/**"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.d.ts"],
    rules: { "@typescript-eslint/no-empty-object-type": "off" },
  },
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // The codebase deliberately uses `any` at protocol boundaries (pi RPC
      // payloads are untyped JSON); tighten incrementally.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "vue/multi-word-component-names": "off",
    },
  },
);
