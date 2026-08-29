import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // The worker app imports the detect package by name; its package entry is the built dist, so the
        // unit run reads the source instead and needs no build.
        resolve: { alias: { '@washtrace/detect': fileURLToPath(new URL('./packages/detect/src/index.ts', import.meta.url)) } },
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts'],
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
