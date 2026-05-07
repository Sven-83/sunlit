// @ts-check
import iobrokerConfig from "@iobroker/eslint-config";
import globals from "globals";

export default [
  {
    // Files we never lint — generated, vendored, or out-of-scope.
    ignores: [
      "build/**",
      "node_modules/**",
      "admin/build/**",
      "admin/words.js",
      ".test-data/**",
      "coverage/**",
      ".iobroker-data/**",
    ],
  },
  ...iobrokerConfig,
  {
    // Adapter-specific rule tweaks (kept minimal).
    rules: {
      // We document via inline comments rather than full JSDoc on every member.
      "jsdoc/require-jsdoc": "off",
      // Allow inline TypeScript imports of devDeps in tests.
      "import/no-extraneous-dependencies": "off",
    },
  },
  {
    // Test files — Mocha globals, slightly relaxed.
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
    rules: {
      // Tests legitimately import devDeps and have descriptive long lines.
      "@typescript-eslint/no-unused-expressions": "off",
      // chai's `expect(x).to.be.true` chain triggers this; allowed in tests.
      "@typescript-eslint/no-non-null-assertion": "off",
      "jsdoc/require-param-description": "off",
    },
  },
];
