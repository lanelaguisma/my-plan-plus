-- ============================================================
-- 0032 — Reminder: commander WAM prep
-- In the 24 hours before each WAM, a group commander sees who can't
-- make it and who still owes last week's check-in, so they can follow
-- up (or log a check-in on someone's behalf). RSVPs default to
-- attending, so there is no "hasn't RSVP'd". Shown only while that list
-- has anyone on it.
-- ============================================================

create or replace function public.wam_prep_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  with led as (
    select gs.group_id, gs.cycle_id, g.name as group_name, w.week, w.starts_at
    from public.group_seasons gs
    join public.groups g on g.id = gs.group_id
    join public.cycles c on c.id = gs.cycle_id and c.status = 'active'
    cross join lateral public.season_wams(gs.group_id, gs.cycle_id) w
    where gs.commander_id = auth.uid() and not gs.dormant
      and not w.cancelled and w.starts_at > now() and w.starts_at <= now() + interval '24 hours'
  ),
  roster as (
    select l.*, r.user_id
    from led l join public.group_members r
      on r.group_id = l.group_id and r.cycle_id = l.cycle_id and r.status = 'on_roster'
    where r.user_id <> auth.uid()
  ),
  away as (
    select ro.group_id, ro.cycle_id, ro.week,
           string_agg(public.member_name(ro.user_id), ', ' order by public.member_name(ro.user_id)) as names
    from roster ro
    where exists (select 1 from public.rsvps v where v.group_id = ro.group_id and v.cycle_id = ro.cycle_id
                  and v.week = ro.week and v.member_id = ro.user_id)
    group by 1, 2, 3
  ),
  owing as (
    select ro.group_id, ro.cycle_id, ro.week,
           string_agg(public.member_name(ro.user_id), ', ' order by public.member_name(ro.user_id)) as names
    from roster ro
    where ro.week > 1 and not exists (select 1 from public.checkins k
      where k.user_id = ro.user_id and k.cycle_id = ro.cycle_id and k.week = ro.week - 1)
    group by 1, 2, 3
  )
  select 'wam_prep:' || l.group_id || ':' || l.cycle_id || ':' || l.week, 'wam_prep', 'commander',
         format('%s week %s WAM prep: %s', l.group_name, l.week,
                concat_ws('; ',
                  case when a.names is not null then a.names || ' can''t make it' end,
                  case when o.names is not null then o.names || ' still owe' || case when o.names like '%,%' then '' else 's' end
                                                   || ' the week ' || (l.week - 1) || ' check-in' end) || '.'),
         'view_roster',
         jsonb_build_object('group_id', l.group_id, 'season_id', l.cycle_id, 'week', l.week),
         l.starts_at, false
  from led l
  left join away a using (group_id, cycle_id, week)
  left join owing o using (group_id, cycle_id, week)
  where a.names is not null or o.names is not null
$$;
revoke execute on function public.wam_prep_reminders() from public, anon, authenticated;

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
$$;
