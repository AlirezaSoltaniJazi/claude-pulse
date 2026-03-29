import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/ui/webviewContent.ts'],
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
});
