import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Каждый тест владеет своим tmpdir (TESTS.md §1.3), поэтому файлы можно
    // гонять параллельно. Внутри файла — последовательно, так проще читать падения.
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // Only the protocol package carries a coverage threshold: it is pure logic and
      // the cost of a bug there is highest (docs/TESTS.md §7).
      include: ['packages/protocol/src/**'],
      // Re-export barrel, nothing to cover.
      exclude: ['packages/protocol/src/index.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85 },
    },
  },
});
