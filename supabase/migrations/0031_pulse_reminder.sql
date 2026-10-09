-- ============================================================
-- 0031 — Reminder: pulse due
-- In weeks 4, 8 and 13 a member owes their group a pulse, due by the
-- end of that week. It replaces the pulse notice.
-- ============================================================

create or replace function public.pulse_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  select 'pulse:' || r.cycle_id || ':' || wk.week, 'pulse', 'member',
         format('How is %s working for you? Week %s pulse — it takes one tap.', g.name, wk.week),
         'answer_pulse',
         jsonb_build_object('season_id', r.cycle_id, 'week', wk.week),
         (c.start_date + 7 * wk.week)::timestamptz,
         false
  from public.group_members r
  join public.cycles c on c.id = r.cycle_id and c.status = 'active'
  join public.groups g on g.id = r.group_id
  cross join lateral (select public.current_season_week(c.id) as week) wk
  where r.user_id = auth.uid() and r.status = 'on_roster' and wk.week in (4, 8, 13)
    and not exists (select 1 from public.pulses p
      where p.member_id = auth.uid() and p.cycle_id = r.cycle_id and p.week = wk.week)
$$;
revoke execute on function public.pulse_reminders() from public, anon, authenticated;

create or replace function public.my_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  select * from public.checkin_reminders()
  union all
  select * from public.continuation_reminders()
  union all
  select * from public.pulse_reminders()
$$;

-- Pulse is a reminder now, not a notice.
create or replace function public.derived_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select * from public.wam_upcoming_notices()
$$;
drop function public.pulse_notices();
