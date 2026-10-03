# My Plan+ Community

A lightweight web app for running **12 Week Year** accountability communities, by [Logic2Design](https://www.logic2design.com).

People register, nominate the weekly **45-minute session times** they can attend (with one preferred time ★), then **join, create, or get randomly allocated into** an accountability group that shares a suitable time — across time zones. Once in a group, each member runs their own 12-week plan: goals & tactics, weekly check-ins against the five WAM questions, reports, and exports.

![My Plan+](MyPlan+.png)

## Features

- **Accounts** — email + password registration, sign-in from any device, password reset.
- **Availability & preferred time** — tap a weekly grid in your local time zone; times are stored in UTC so cross-time-zone groups match correctly.
- **Groups** — join an existing group (until it reaches its typical size of 4), create your own, or be randomly allocated with everyone who didn't choose. The next cycle can open for sign-up while the current one is still running.
- **Admin panel** — create/edit cycles, open sign-up, run random allocation (favours preferred times), create groups, move members between groups, add meeting links, email individuals/groups/everyone, export registrant lists.
- **Planning tools** — the full My Plan+ 12 Week Year tracker per member: goals, tactics, weekly check-in sliders and reflections, trend charts, PDF/CSV archive, JSON backup.
- **Team accountability** — saved check-ins feed a shared scoreboard: your group's member-by-week scores and answers, a combined team trend chart, and a leaderboard of every group's combined scores.
- **Message boards** — a private board per group plus admin-created community boards, with unread tracking and sorting.

Privacy: goals, tactics and drafts are private per member (enforced by database row-level security). A saved weekly check-in (score + answers) is shared with the member's group; scores alone feed the community leaderboard.

## How it's built

One static HTML file (`index.html`) — no build step, no framework — backed by a free [Supabase](https://supabase.com) project for accounts and data (Postgres with row-level security). Charts via Chart.js.

- `index.html` — the community app. Point it at your own Supabase project by editing the `CONFIG` block near the top of its `<script>`.
- `supabase/migrations/` — the database schema as ordered migrations; apply them in filename order.
- `SETUP.md` — step-by-step setup guide (~15 minutes): create the Supabase project, run the migrations, paste the two keys, host, make yourself admin.
- `test/` — dev-only tests of the database contract (rules and row-level security), run in-process with PGlite: `npm install && npm test`. No Docker or hosted project needed; the app itself still has no build step.
- `myPlanPlus-single-user.html` — the original offline, single-user version (localStorage only, no account needed).

> The Supabase URL and *publishable* key embedded in `index.html` are public by design — they identify the project, while row-level security controls what each signed-in user can read or write. To run your own community, replace them with your own project's values.

## Quick start

1. Follow `SETUP.md` to create your Supabase backend.
2. Serve `index.html` and `MyPlan+.png` from any static host (GitHub Pages works).
3. Register in the app, then make yourself admin:
   ```sql
   update public.profiles set is_admin = true where email = 'you@example.com';
   ```
4. Create a cycle, open sign-up, and share the link.

## Background

Based on *The 12 Week Year* by Brian P. Moran and Michael Lennington. The Learn tab inside the app summarises the method.
