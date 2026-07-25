const js = require('@eslint/js');
const globals = require('globals');

// pdfsign has no bundler — js/** ships to the browser as native ES modules,
// tests/scripts run under Node as CommonJS, and sw.js runs in the service
// worker global scope. Each needs its own globals, so they're split here
// rather than sharing one environment.
module.exports = [
  js.configs.recommended,

  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Loaded as plain (non-module) <script> tags in index.html, ahead
        // of js/app.js, so they're ambient globals rather than imports.
        pdfjsLib: 'readonly',
        PDFLib: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // "catch {}" is used deliberately throughout as a best-effort parse
      // fallback (extractJSON's cascade, streamed-chunk JSON parsing).
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
  },

  {
    files: ['tests/**/*.js', 'scripts/**/*.js', 'playwright.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      // Test files also embed page.evaluate() callbacks that run in the
      // browser and reference the app's own script-tag globals.
      globals: { ...globals.node, ...globals.browser, PDFLib: 'readonly', pdfjsLib: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    ignores: ['vendor/**', 'dist/**', 'src-tauri/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
];
