import { defineConfig } from 'vitest/config';

// One runner for every workspace, plus test/ at the root for tests that cross them (the flowchart). Tests are pure
// TypeScript (no DOM), so the node environment is enough.
export default defineConfig({
  test: {
    include: ['{shared,hub,app}/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
