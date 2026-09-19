import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: ["main.js", "tests/**", "scripts/**", "node_modules/**", "esbuild.config.mjs", "eslint.config.mjs"]
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // "Antigravity" and "Gemini" are product names that must keep their case.
      "obsidianmd/ui/sentence-case": "off"
    }
  }
);
