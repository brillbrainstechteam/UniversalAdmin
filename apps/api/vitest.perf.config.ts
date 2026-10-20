import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Performance fixtures (Phase 11): bulk data + timed endpoints. Run with `pnpm --filter @uc/api perf`. */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    include: ['perf/**/*.perf.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
