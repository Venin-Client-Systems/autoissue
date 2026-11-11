import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // E2E tests create real git branches and worktrees (autoissue/issue-N) in the
    // same repository, so test files must not run concurrently or they collide.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        '__tests__/',
        'dist/',
        'legacy/',
        '*.config.ts',
      ],
    },
  },
});
