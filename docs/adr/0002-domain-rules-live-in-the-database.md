# Domain rules live in the database, behind RPC functions and views

The app is one static `index.html` that writes Supabase tables directly, with its rules split between browser JavaScript and row-level security. For the club features (placement, continuation, rosters, WAMs, health flags, suggested matches) we decided that every rule and permission lives in Postgres: role-checked RPC functions for anything that changes state, views or functions for anything derived, and row-level security for visibility. `index.html` stays a thin UI over that contract. This gives one test seam, the database contract exercised as a member, group commander or club manager, runnable in Node through PGlite with no Docker or hosted project. It also means the rules can't be bypassed by a modified client, since the publishable key is public.

## Considered Options

- **Rules in a pure JS module extracted from `index.html`**: easier to write, but adds a second test seam, and every permission would still have to be duplicated in row-level security.
- **Browser end-to-end tests only**: the highest seam, but needs a hosted test project and is slow and flaky.

## Consequences

- New client writes go through RPC functions, not direct table inserts or updates. Existing direct writes for the personal 12-week plan (`plan_data`, `checkins`) stay as they are.
- Schema changes ship as ordered migration files that both the test harness and the production setup apply, so the two can't drift apart.
- The existing random allocation proposal can stay in the browser (it is a preview a club manager re-runs), but saving it goes through the same assignment function as any other assignment.
