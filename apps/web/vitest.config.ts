import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const detectSrc = (file: string) => fileURLToPath(new URL(`../../packages/detect/src/${file}.ts`, import.meta.url));

/**
 * The app's own config rather than a project in the root one: the jsdom
 * environment, the React plugin and the `@` alias are this app's alone, and
 * Vite resolves the alias relative to this file. The detect package's entry is
 * its built dist, so the tests read its source instead (as the root config's
 * unit project does) and need no build; each subpath export in its
 * package.json has an alias here.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) },
      { find: /^@washtrace\/detect$/, replacement: detectSrc('index') },
      ...['bytes', 'trades', 'lens-rule', 'lens-reads'].map((name) => ({ find: `@washtrace/detect/${name}`, replacement: detectSrc(name) })),
    ],
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
