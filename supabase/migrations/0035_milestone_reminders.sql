-- ============================================================
-- 0035 — Reminder: season milestones
-- For club managers: enrolment due to open or close within 7 days
-- (overdue once the date has passed without it happening), the running
-- season reaching its week 13, and no next season created by week 10.
-- Dates come from season_enrolment_dates().
-- ============================================================

create or replace function public.milestone_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  with seasons as (
    select c.*, d.opens_on, d.closes_on, public.current_season_week(c.id) as week
    from public.cycles c cross join lateral public.season_enrolment_dates(c.id) d
    where public.is_admin()
  ),
  in_days as (
    select n, case when n > 1 then format('in %s days', n) when n = 1 then 'tomorrow'
                   when n = 0 then 'today' when n = -1 then 'yesterday' else format('%s days ago', -n) end as label
    from generate_series(-400, 7) n
  )
  select 'milestone:opens:' || s.id, 'milestone_enrolment_opens', 'manager',
         format('Enrolment for %s is due to open %s.', s.name, i.label), 'open_seasons',
         jsonb_build_object('season_id', s.id), s.opens_on::timestamptz, s.opens_on < current_date
  from seasons s join in_days i on i.n = s.opens_on - current_date
  where s.status = 'setup'
  union all
  select 'milestone:closes:' || s.id, 'milestone_enrolment_closes', 'manager',
         format('Enrolment for %s is due to close %s.', s.name, i.label), 'open_seasons',
         jsonb_build_object('season_id', s.id), (s.closes_on + 1)::timestamptz, s.closes_on < current_date
  from seasons s join in_days i on i.n = s.closes_on - current_date
  where s.status = 'enrolling'
  union all
  select 'milestone:week13:' || s.id, 'milestone_week13', 'manager',
         format('%s is in week 13, its break and reflection week: get the next season ready to start.', s.name),
         'open_seasons', jsonb_build_object('season_id', s.id), (s.start_date + 91)::timestamptz, false
  from seasons s
  where s.status = 'active' and s.week = 13
  union all
  select 'milestone:next:' || s.id, 'milestone_no_next_season', 'manager',
         format('%s is in week %s and no season after it has been created yet.', s.name, s.week),
         'open_seasons', jsonb_build_object('season_id', s.id), (s.start_date + 77)::timestamptz, s.week >= 12
  from seasons s
  where s.status = 'active' and s.week >= 10
    and not exists (select 1 from public.cycles n where n.start_date > s.start_date)
$$;
revoke execute on function public.milestone_reminders() from public, anon, authenticated;

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
  union all
  select * from public.club_reminders()
  union all
  select * from public.milestone_reminders()
$$;
