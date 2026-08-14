import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Lint rules, deliberately few.
 *
 * Formatting is Prettier's job and is switched off here entirely (`prettier` last).
 * What is left are the rules that catch mistakes rather than opinions: an unused
 * import, a floating promise in code that writes files, an `any` slipped in to make
 * the compiler quiet.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/out/**', 'coverage/**', 'docs-local/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // TypeScript already knows what exists; `no-undef` here only misreads Node globals.
    files: ['**/*.ts'],
    rules: { 'no-undef': 'off' },
  },
  {
    // Scripts are tools for a human at a terminal; printing is the point, and they run
    // on Node, where `Buffer` and friends are ambient.
    files: ['**/*.mjs', 'packages/*/scripts/**'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'Buffer',
          'console',
          'process',
          'setTimeout',
          'clearTimeout',
          'URL',
          'TextEncoder',
          'TextDecoder',
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
