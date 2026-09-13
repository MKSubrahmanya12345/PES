import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'cad-helper': path.resolve(__dirname, './cad-helper/index.ts'),
      '@cad-helper': path.resolve(__dirname, './cad-helper'),
    },
  },
});

