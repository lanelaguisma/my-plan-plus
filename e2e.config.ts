import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// End-to-end tests drive the real index.html against a local, Docker-free
// stand-in for Supabase (e2e/stack): PGlite with every migration, PostgREST,
// and a small auth service. No model is configured: the tests use locators
// and assertions only.
export default {
  tests: ['e2e/tests/**/*.e2e.ts'],
  targets: [{
    name: 'web',
    engine: web(),
    app: {
      url: 'http://127.0.0.1:54321',
      readyUrl: 'http://127.0.0.1:54321/__e2e/health',
      command: {
        executable: 'node',
        args: ['e2e/stack/server.mjs'],
        reuseExisting: true,
        log: '.e2e/logs/stack.log',
        startupTimeout: 120_000,
      },
    },
  }],
  // One shared database: tests run one at a time, each from a clean slate.
  workers: 1,
} satisfies E2EConfig;
