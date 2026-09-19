-- ============================================================
-- My Plan+ Community — Update 2
-- Adds shared weekly check-ins for group accountability:
--   * members of a group see each other's weekly check-ins
--     (score + reflection answers)
--   * everyone sees every group's combined weekly scores
--     (scores only — no reflection detail across groups)
--
-- Run this ONCE in the Supabase dashboard (SQL Editor > New query),
-- after supabase-update-1.sql. Fresh projects only need
-- supabase-schema.sql, which now includes all of this.
-- ============================================================

-- ---------- Preferred availability slot ----------
-- Members can mark ONE of their nominated times as preferred;
-- allocation favours preferred times when forming groups.
alter table public.profiles add column if not exists preferred_slot integer;

-- ---------- Shared weekly check-ins ----------
-- One row per member per week of a cycle, written automatically
-- when the member saves their weekly check-in in the app.
create table if not exists public.checkins (
  user_id uuid not null references public.profiles(id) on delete cascade,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  week integer not null check (week between 1 and 13),
  score integer not null default 0 check (score between 0 and 100),
  author_name text default '',
  reflections jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, cycle_id, week)
);
create index if not exists checkins_cycle_idx on public.checkins(cycle_id, week);

alter table public.checkins enable row level security;

-- Full check-in detail: yourself, your group-mates, and admins
create policy "checkins_select" on public.checkins
  for select to authenticated using (
    user_id = auth.uid()
    or public.is_admin()
    or user_id in (
      select gm2.user_id from public.group_members gm2
      where gm2.group_id in (
        select gm.group_id from public.group_members gm where gm.user_id = auth.uid()
      )
    )
  );
create policy "checkins_insert_own" on public.checkins
  for insert to authenticated with check (user_id = auth.uid());
create policy "checkins_update_own" on public.checkins
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "checkins_delete" on public.checkins
  for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- Scores-only view for the cross-group leaderboard. The view runs with
-- its owner's rights (deliberately bypassing the row policy above) and
-- exposes ONLY user_id/cycle/week/score — never the reflections.
create or replace view public.checkin_scores as
  select user_id, cycle_id, week, score, updated_at from public.checkins;
revoke all on public.checkin_scores from anon;
grant select on public.checkin_scores to authenticated;
