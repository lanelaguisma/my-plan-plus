-- ============================================================
-- 0033 — Reminder: attendance unconfirmed
-- Once a WAM ends, its group commander owes the attendance record,
-- overdue after 24 hours. Like check-ins, only the last two WAMs held
-- are asked about, so an old backlog doesn't pile up. Cancelled WAMs
-- are excluded; a club manager confirming also settles it.
-- ============================================================

create or replace function public.attendance_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  with held as (
    select gs.group_id, gs.cycle_id, g.name as group_name, w.week, w.starts_at,
           row_number() over (partition by gs.group_id, gs.cycle_id order by w.week desc) as rn
    from public.group_seasons gs
    join public.groups g on g.id = gs.group_id
    join public.cycles c on c.id = gs.cycle_id and c.status = 'active'
    cross join lateral public.season_wams(gs.group_id, gs.cycle_id) w
    where gs.commander_id = auth.uid() and not gs.dormant
      and not w.cancelled and public.wam_ends_at(w.starts_at) <= now()
  )
  select 'attendance:' || h.group_id || ':' || h.cycle_id || ':' || h.week, 'attendance_unconfirmed', 'commander',
         format('Confirm who attended %s''s week %s WAM.', h.group_name, h.week),
         'confirm_attendance',
         jsonb_build_object('group_id', h.group_id, 'season_id', h.cycle_id, 'week', h.week),
         public.wam_ends_at(h.starts_at) + interval '24 hours',
         now() >= public.wam_ends_at(h.starts_at) + interval '24 hours'
  from held h
  where h.rn <= 2
    and not exists (select 1 from public.attendance_confirmations a
      where a.group_id = h.group_id and a.cycle_id = h.cycle_id and a.week = h.week)
$$;
revoke execute on function public.attendance_reminders() from public, anon, authenticated;

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
  union all
  select * from public.wam_prep_reminders()
  union all
  select * from public.attendance_reminders()
$$;
