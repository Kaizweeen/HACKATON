import { defineConfig } from 'vitest/config';

// One runner for every workspace. Tests are pure TypeScript (no DOM), so the node environment is enough.
export default defineConfig({
  test: {
    include: ['{shared,hub,app}/test/**/*.test.ts'],
    environment: 'node',
  },
});
