-- ============================================================
-- 0028 — Reminders
-- A reminder is an action someone still owes. Reminders are worked out
-- when read, never stored, so one goes away as soon as the action is
-- done; they can't be dismissed or marked read. Each kind is its own
-- function, combined in my_reminders(), the same way derived notices are.
-- ============================================================

-- A WAM runs for 45 minutes.
create or replace function public.wam_ends_at(p_starts_at timestamptz)
returns timestamptz
language sql immutable
as $$ select p_starts_at + interval '45 minutes' $$;

-- Every reminder for the signed-in person, tagged with the mode it
-- belongs to. Later migrations add each kind of reminder here.
create or replace function public.my_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  select null::text, null::text, null::text, null::text, null::text, null::jsonb,
         null::timestamptz, null::boolean
  where false
$$;
grant execute on function public.my_reminders() to authenticated;
