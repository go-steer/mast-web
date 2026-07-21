// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// ESLint flat config for mast-web. Vanilla JS only (no TypeScript, no
// framework). Browser globals + Vitest test globals.

import globals from "globals";

export default [
  {
    files: ["web/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // Markdown/highlight bundles loaded via CDN <script> tags.
        marked: "readonly",
        markedHighlight: "readonly",
        hljs: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "warn",
    },
  },
  {
    files: [
      "**/*.test.js",
      "**/*.spec.js",
      // Conformance harness runs under Node (vitest / import) only,
      // never in the browser bundle — treat as ES modules so import /
      // export parse cleanly.
      "web/attach-core/conformance/**/*.js",
      // Playwright smoke tests + shared helpers run under Node/Playwright.
      "smoke/**/*.js",
      "playwright.config.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        vi: "readonly",
        // Playwright injects `test` + its own `expect` for the .spec.js
        // files; leaving them here so the JS lint doesn't false-positive
        // when the spec author writes `test.describe(...)`.
        test: "readonly",
      },
    },
  },
];
