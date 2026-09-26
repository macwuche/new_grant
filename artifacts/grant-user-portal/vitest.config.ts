import path from 'path';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, which requires PORT/BASE_PATH for the dev server.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
