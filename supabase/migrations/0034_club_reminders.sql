-- ============================================================
-- 0034 — Reminder: club needs attention
-- For club managers, one standing reminder per kind of open work in the
-- running and enrolling seasons: At Risk groups, unplaced members, open
-- transfer requests and pending members still to register. Each lasts
-- while there is anything of its kind.
-- ============================================================

create or replace function public.club_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  n integer;
  names text;
begin
  if not public.is_admin() then
    return;
  end if;
  for s in select id, name from public.cycles where status in ('active', 'enrolling') order by start_date loop
    select count(distinct f.group_id), string_agg(distinct f.group_name, ', ')
      into n, names
      from public.compute_health_flags(s.id, null, true) f;
    if n > 0 then
      return query select 'club:at_risk:' || s.id, 'club_at_risk', 'manager',
        format('%s group%s at risk in %s: %s.', n, case when n = 1 then ' is' else 's are' end, s.name, names),
        'view_health', jsonb_build_object('season_id', s.id, 'count', n), null::timestamptz, false;
    end if;

    select count(*) into n from public.unplaced_members(s.id);
    if n > 0 then
      return query select 'club:unplaced:' || s.id, 'club_unplaced', 'manager',
        format('%s unplaced member%s for %s — place them in a group.', n, case when n = 1 then '' else 's' end, s.name),
        'review_unplaced', jsonb_build_object('season_id', s.id, 'count', n), null::timestamptz, false;
    end if;

    select count(*) into n from public.transfer_requests t where t.cycle_id = s.id and t.status = 'open';
    if n > 0 then
      return query select 'club:transfers:' || s.id, 'club_transfers', 'manager',
        format('%s open transfer request%s for %s.', n, case when n = 1 then '' else 's' end, s.name),
        'review_transfers', jsonb_build_object('season_id', s.id, 'count', n), null::timestamptz, false;
    end if;

    select count(*) into n from public.pending_members pm where pm.cycle_id = s.id and pm.status = 'pending';
    if n > 0 then
      return query select 'club:pending:' || s.id, 'club_pending', 'manager',
        format('%s pending member%s for %s %s still to register.', n, case when n = 1 then '' else 's' end, s.name,
               case when n = 1 then 'is' else 'are' end),
        'review_pending', jsonb_build_object('season_id', s.id, 'count', n), null::timestamptz, false;
    end if;
  end loop;
end
$$;
revoke execute on function public.club_reminders() from public, anon, authenticated;

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
$$;
