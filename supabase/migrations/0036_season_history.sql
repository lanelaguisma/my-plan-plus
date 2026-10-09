-- ============================================================
-- 0036 — Season history
-- Looking back across seasons: a member's own seasons, a group's
-- seasons for its commander, and every group by season for club
-- managers. Covers archived seasons and the one running now. Groups are
-- only ever summarised; no one sees another member's individual rows.
-- ============================================================

-- Internal: one group's numbers for one season.
create or replace function public.group_season_stats(p_group uuid, p_season uuid)
returns table (roster_size integer, retained integer, attendance_pct integer, average_checkin integer, average_pulse numeric)
language sql stable security definer set search_path = public
as $$
  with roster as (
    select r.user_id from public.group_members r
    where r.group_id = p_group and r.cycle_id = p_season and r.status = 'on_roster'
  ),
  previous as (
    select gs.cycle_id from public.group_seasons gs join public.cycles c on c.id = gs.cycle_id
    where gs.group_id = p_group and c.start_date < (select start_date from public.cycles where id = p_season)
    order by c.start_date desc limit 1
  ),
  held as (
    select w.week from public.season_wams(p_group, p_season) w where not w.cancelled and w.starts_at <= now()
  )
  select
    (select count(*)::int from roster),
    (select count(*)::int from roster ro join public.group_members p
       on p.user_id = ro.user_id and p.group_id = p_group and p.status = 'on_roster'
      where p.cycle_id = (select cycle_id from previous)),
    (select round(100.0 * count(*) filter (where public.attended_wam(p_group, p_season, h.week, ro.user_id))
                  / nullif(count(*), 0))::int
       from held h cross join roster ro),
    (select round(avg(k.score))::int from public.checkins k join roster ro on ro.user_id = k.user_id
      where k.cycle_id = p_season and k.week between 1 and 12),
    (select round(avg(case p.rating when 'working' then 3 when 'so_so' then 2 else 1 end), 1)
       from public.pulses p where p.group_id = p_group and p.cycle_id = p_season)
$$;
revoke execute on function public.group_season_stats(uuid, uuid) from public, anon, authenticated;

-- The signed-in member's own seasons, newest first.
create or replace function public.my_season_history()
returns table (season_id uuid, season_name text, start_date date, season_status text, group_name text,
               commander_name text, average_checkin integer, checkins_submitted integer, attendance_pct integer)
language sql stable security definer set search_path = public
as $$
  select c.id, c.name, c.start_date, c.status, g.name, public.member_name(gs.commander_id),
         (select round(avg(k.score))::int from public.checkins k
           where k.user_id = auth.uid() and k.cycle_id = c.id and k.week between 1 and 12),
         (select count(*)::int from public.checkins k
           where k.user_id = auth.uid() and k.cycle_id = c.id and k.week between 1 and 12),
         (select round(100.0 * count(*) filter (where public.attended_wam(r.group_id, c.id, w.week, auth.uid()))
                       / nullif(count(*), 0))::int
            from public.season_wams(r.group_id, c.id) w where not w.cancelled and w.starts_at <= now())
  from public.group_members r
  join public.cycles c on c.id = r.cycle_id and c.status in ('active', 'archived')
  join public.groups g on g.id = r.group_id
  join public.group_seasons gs on gs.group_id = r.group_id and gs.cycle_id = r.cycle_id
  where r.user_id = auth.uid() and r.status <> 'awaiting_continuation'
  order by c.start_date desc
$$;
grant execute on function public.my_season_history() to authenticated;

-- One group's seasons, for its commander (in a running or enrolling
-- season) or a club manager. Totals only.
create or replace function public.group_season_history(p_group uuid)
returns table (season_id uuid, season_name text, start_date date, season_status text, commander_name text,
               roster_size integer, retained integer, attendance_pct integer, average_checkin integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_admin() or exists (
    select 1 from public.group_seasons gs join public.cycles c on c.id = gs.cycle_id
    where gs.group_id = p_group and gs.commander_id = auth.uid() and c.status in ('active', 'enrolling')
  )) then
    raise exception 'Only this group''s commander or a club manager can see its history';
  end if;
  return query
    select c.id, c.name, c.start_date, c.status, public.member_name(gs.commander_id),
           st.roster_size, st.retained, st.attendance_pct, st.average_checkin
    from public.group_seasons gs
    join public.cycles c on c.id = gs.cycle_id and c.status in ('active', 'archived')
    cross join lateral public.group_season_stats(gs.group_id, gs.cycle_id) st
    where gs.group_id = p_group
    order by c.start_date desc;
end
$$;
grant execute on function public.group_season_history(uuid) to authenticated;

-- Every group in every season, for club managers: the cells of a
-- group-by-season grid. average_pulse is 1 (not working) to 3 (working well).
create or replace function public.club_season_history()
returns table (group_id uuid, group_name text, season_id uuid, season_name text, start_date date, state text,
               roster_size integer, attendance_pct integer, average_checkin integer, average_pulse numeric)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see the club''s history';
  end if;
  return query
    select sg.id, sg.name, sg.cycle_id, c.name, c.start_date, sg.state,
           st.roster_size, st.attendance_pct, st.average_checkin, st.average_pulse
    from public.season_groups sg
    join public.cycles c on c.id = sg.cycle_id and c.status in ('active', 'archived')
    cross join lateral public.group_season_stats(sg.id, sg.cycle_id) st
    order by sg.name, c.start_date;
end
$$;
grant execute on function public.club_season_history() to authenticated;
