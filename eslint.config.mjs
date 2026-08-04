import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.artifacts/**",
      "**/.next/**",
      "**/.astro/**",
      "**/.wrangler/**",
      "apps/cloudflare-worker/worker-configuration.d.ts",
      "briefs/**",
      "research/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,mts,tsx}"],
  })),
  {
    files: ["**/*.{ts,mts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["apps/nextjs-vercel/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./apps/nextjs-vercel/tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/docs/**/*.{ts,mts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./apps/docs/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        process: "readonly",
        require: "readonly",
      },
    },
  },
  eslintConfigPrettier,
);
