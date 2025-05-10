import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/**/*.int.test.ts'],
          // One Postgres container per file; the store's schema is the whole
          // database, so files must not share one.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      // The web app owns its own config: jsdom, the React plugin and the `@`
      // alias only it needs, rooted where Vite resolves its bare specifiers.
      './apps/web/vitest.config.ts',
    ],
  },
});
