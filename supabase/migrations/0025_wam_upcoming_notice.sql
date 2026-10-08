-- ============================================================
-- 0025 — "WAM is coming up" is a notice, not a reminder
-- Nothing has to be done about an upcoming WAM, so its kind becomes
-- wam_upcoming. Keys are unchanged, so read state carries over.
-- ============================================================

create or replace function public.wam_upcoming_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select 'wam:' || w.group_id || ':' || w.cycle_id || ':' || w.week, 'wam_upcoming',
         format('%s''s WAM is coming up: %s.', w.group_name,
                to_char(w.starts_at at time zone public.my_timezone(), 'Dy FMHH12:MI AM')),
         'join_wam',
         jsonb_build_object('group_id', w.group_id, 'season_id', w.cycle_id, 'week', w.week, 'link', w.link),
         w.starts_at - interval '24 hours'
  from public.my_wams() w
  where not w.cancelled and w.starts_at > now() and w.starts_at <= now() + interval '24 hours'
$$;

create or replace function public.derived_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select * from public.continuation_notices()
  union all
  select * from public.wam_upcoming_notices()
  union all
  select * from public.pulse_notices()
$$;

drop function public.wam_reminder_notices();
