import { defineConfig } from 'vitest/config';

// Each test starts a fresh in-process Postgres from a migrated snapshot
// built once per run (test/global-setup.js).
export default defineConfig({
  test: { testTimeout: 30_000, globalSetup: ['./test/global-setup.js'] },
});
