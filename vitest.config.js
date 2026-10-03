import { defineConfig } from 'vitest/config';

// Each test builds a fresh in-process Postgres from the migrations, which
// takes a second or more when test files run in parallel.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
