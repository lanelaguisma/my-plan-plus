-- ============================================================
-- 0030 — Reminder: confirm continuation
-- While a season is enrolling, a member awaiting continuation owes an
-- answer, counting down to enrolment's planned close (overdue in the
-- last 3 days). It replaces the continuation notice.
-- ============================================================

create or replace function public.continuation_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  select 'continuation:' || r.cycle_id || ':' || r.group_id, 'continuation', 'member',
         format('Are you continuing with %s for %s? %s', g.name, c.name,
                case
                  when d.closes_on is null then 'Please confirm.'
                  when d.closes_on - current_date > 1 then format('%s days left to confirm.', d.closes_on - current_date)
                  when d.closes_on - current_date = 1 then '1 day left to confirm.'
                  else 'Please confirm today.'
                end),
         'confirm_continuation',
         jsonb_build_object('group_id', r.group_id, 'season_id', r.cycle_id, 'days_left', d.closes_on - current_date),
         (d.closes_on + 1)::timestamptz,
         d.closes_on is not null and d.closes_on - current_date < 3
  from public.group_members r
  join public.groups g on g.id = r.group_id
  join public.cycles c on c.id = r.cycle_id
  cross join lateral public.season_enrolment_dates(c.id) d
  where r.user_id = auth.uid() and r.status = 'awaiting_continuation' and c.status = 'enrolling'
$$;
revoke execute on function public.continuation_reminders() from public, anon, authenticated;

create or replace function public.my_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  select * from public.checkin_reminders()
  union all
  select * from public.continuation_reminders()
$$;

-- Continuation is a reminder now, not a notice.
create or replace function public.derived_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select * from public.wam_upcoming_notices()
  union all
  select * from public.pulse_notices()
$$;
drop function public.continuation_notices();
