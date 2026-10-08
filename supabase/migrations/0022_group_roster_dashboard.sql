-- ============================================================
-- 0022 — The group roster dashboard and goal visibility
-- A group commander (and any club manager) sees how each person on the
-- roster is doing at a glance, and can open a member's 12-week goals and
-- weekly scores. Fellow members and other groups' commanders cannot.
-- ============================================================

create or replace function public.can_lead(p_group uuid, p_season uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.is_commander_of(p_group, p_season) or public.is_admin() $$;

-- The season week whose check-ins are due: this week while the season runs,
-- 0 before it starts and 13 after it ends.
create or replace function public.season_week_now(p_season uuid)
returns integer
language sql stable security definer set search_path = public
as $$
  select coalesce(public.current_season_week(p_season),
                  case when current_date < c.start_date then 0 else 13 end)
  from public.cycles c where c.id = p_season
$$;

create or replace function public.group_roster_dashboard(p_group uuid, p_season uuid)
returns table (
  member_id uuid, pending_id uuid, full_name text, timezone text, status text, is_commander boolean,
  latest_week integer, latest_score integer, average_score integer, streak integer,
  attended integer, held integer, next_week integer, next_can_attend boolean, next_note text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_week integer := public.season_week_now(p_season);
begin
  if not public.can_lead(p_group, p_season) then
    raise exception 'Only the group''s commander can see its roster dashboard';
  end if;
  return query
    with roster as (
      select r.user_id, r.status from public.group_members r
      where r.group_id = p_group and r.cycle_id = p_season and r.status <> 'departed'
    ),
    held as (
      select w.week from public.season_wams(p_group, p_season) w
      where not w.cancelled and w.starts_at <= now()
      order by w.week desc limit 3
    ),
    next_wam as (
      select min(w.week) as week from public.season_wams(p_group, p_season) w
      where not w.cancelled and w.starts_at > now() - interval '45 minutes'
    ),
    scores as (
      select k.user_id, k.week, k.score from public.checkins k
      join roster on roster.user_id = k.user_id
      where k.cycle_id = p_season and k.week between 1 and 12
    )
    select ro.user_id, null::uuid, coalesce(nullif(p.full_name, ''), p.email), p.timezone, ro.status,
           gs.commander_id is not distinct from ro.user_id,
           (select max(s.week) from scores s where s.user_id = ro.user_id),
           (select s.score from scores s where s.user_id = ro.user_id order by s.week desc limit 1),
           (select round(avg(s.score))::int from scores s where s.user_id = ro.user_id),
           -- Consecutive weeks checked in, ending this week (or last week, if
           -- this week's check-in isn't in yet).
           (select k0 - coalesce(max(w), 0) from (
              select case when exists (select 1 from scores s where s.user_id = ro.user_id and s.week = least(v_week, 12))
                          then least(v_week, 12) else least(v_week, 13) - 1 end as k0) b
            left join lateral generate_series(1, greatest(b.k0, 0)) w on not exists (
              select 1 from scores s where s.user_id = ro.user_id and s.week = w)
            group by k0)::int,
           (select count(*)::int from held h where public.attended_wam(p_group, p_season, h.week, ro.user_id)),
           (select count(*)::int from held),
           nw.week,
           not exists (select 1 from public.rsvps r where r.group_id = p_group and r.cycle_id = p_season
                         and r.week = nw.week and r.member_id = ro.user_id),
           (select r.note from public.rsvps r where r.group_id = p_group and r.cycle_id = p_season
              and r.week = nw.week and r.member_id = ro.user_id)
    from roster ro
    join public.profiles p on p.id = ro.user_id
    join public.group_seasons gs on gs.group_id = p_group and gs.cycle_id = p_season
    cross join next_wam nw
    union all
    select null, pm.id, pm.full_name, null, 'pending_registration', false,
           null, null, null, null, null, null, null, null, null
    from public.pending_members pm
    where pm.group_id = p_group and pm.cycle_id = p_season and pm.status = 'pending'
    order by 6 desc, 3;
end
$$;

-- A roster member's 12-week goals and tactics, and their weekly scores this
-- season, for their group commander or a club manager.
create or replace function public.member_plan(p_member uuid, p_season uuid)
returns table (goals jsonb, tactics jsonb, scores jsonb)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_group uuid;
begin
  select r.group_id into v_group from public.group_members r
    where r.user_id = p_member and r.cycle_id = p_season and r.status <> 'departed';
  if not (public.is_admin() or (v_group is not null and public.is_commander_of(v_group, p_season))) then
    raise exception 'Only the member''s group commander or a club manager can see their plan';
  end if;
  return query
    select coalesce((select d.data from public.plan_data d where d.user_id = p_member and d.key = 'myplanplus_goals'), '[]'::jsonb),
           coalesce((select d.data from public.plan_data d where d.user_id = p_member and d.key = 'myplanplus_tactics'), '[]'::jsonb),
           coalesce((select jsonb_agg(jsonb_build_object('week', k.week, 'score', k.score) order by k.week)
                     from public.checkins k where k.user_id = p_member and k.cycle_id = p_season), '[]'::jsonb);
end
$$;
