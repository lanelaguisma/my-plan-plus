-- ============================================================
-- My Plan+ Community — Update 3
-- Lets the NEXT cycle open for sign-up while the current cycle
-- is still running: adds the 'enrolling' cycle status.
-- Cycle lifecycle: setup -> enrolling (open for sign-up)
--                  -> active (running) -> archived.
--
-- Run this ONCE in the Supabase dashboard (SQL Editor > New query),
-- after supabase-update-1.sql and supabase-update-2.sql.
-- Fresh projects only need supabase-schema.sql.
-- ============================================================

alter table public.cycles drop constraint if exists cycles_status_check;
alter table public.cycles add constraint cycles_status_check
  check (status in ('setup', 'enrolling', 'active', 'archived'));
