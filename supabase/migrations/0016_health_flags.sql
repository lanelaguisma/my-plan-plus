-- ============================================================
-- 0016 — Health flags, the club overview and at-risk notices
-- A health flag is a named reason a group needs attention; a group with
-- any flag is at risk. Club managers are told when a group becomes at
-- risk or loses its commander, as the state that causes it changes.
-- ============================================================

alter table public.club_settings
  add column stale_invitation_days integer not null default 3,
  add column attendance_threshold integer not null default 75 check (attendance_threshold between 0 and 100),
  add column attendance_window integer not null default 3 check (attendance_window > 0),
  add column missed_streak integer not null default 2 check (missed_streak > 0);

-- Internal: every flag for a season's running groups (or one group).
-- `p_named` names members in pulse flags (club managers); otherwise pulse
-- concerns are only counted (group commanders).
create or replace function public.compute_health_flags(p_season uuid, p_group uuid, p_named boolean)
returns table (group_id uuid, group_name text, flag text, detail text)
language sql stable security definer set search_path = public
as $$
  with season as (select * from public.cycles where id = p_season),
  cs as (select * from public.club_settings),
  gs as (
    select * from public.season_groups
    where cycle_id = p_season and not dormant and (p_group is null or id = p_group)
  ),
  roster as (
    select r.group_id, r.user_id from public.group_members r
    where r.cycle_id = p_season and r.status = 'on_roster'
  ),
  held as (
    select gs.id as group_id, w.week,
           row_number() over (partition by gs.id order by w.week desc) as rn
    from gs cross join lateral public.season_wams(gs.id, p_season) w
    where not w.cancelled and w.starts_at <= now()
  ),
  recent as (
    select h.group_id, h.week, h.rn from held h, cs where h.rn <= cs.attendance_window
  ),
  flags as (
    select gs.id, 'no_commander' as flag, 'No group commander.' as detail
      from gs where gs.commander_id is null
    union all
    select gs.id, 'below_minimum',
           format('%s member%s — below the minimum of %s.', gs.member_count,
                  case when gs.member_count = 1 then '' else 's' end, cs.min_size)
      from gs, cs where gs.member_count < cs.min_size
    union all
    select gs.id, 'vacancy',
           format('%s open place%s.', gs.vacancies, case when gs.vacancies = 1 then '' else 's' end)
      from gs where gs.vacancies > 0
    union all
    select o.group_id, 'stale_invitation',
           format('%s invitation%s unanswered for over %s days.', count(*),
                  case when count(*) = 1 then '' else 's' end, max(cs.stale_invitation_days))
      from public.placement_offers o join gs on gs.id = o.group_id, cs
      where o.cycle_id = p_season and o.kind = 'invitation' and public.offer_status(o) = 'pending'
        and o.sent_at < now() - make_interval(days => cs.stale_invitation_days)
      group by o.group_id
    union all
    select gs.id, 'few_continuations',
           format('Only %s confirmed continuing — %s needed.',
                  (select count(*) from roster r where r.group_id = gs.id), cs.min_size)
      from gs, cs, season
      where season.status = 'enrolling'
        and (select count(*) from roster r where r.group_id = gs.id) < cs.min_size
    union all
    select a.group_id, 'low_attendance',
           format('Attendance %s%% over the last %s WAMs.', a.pct, a.weeks)
      from (
        select rc.group_id, count(distinct rc.week) as weeks,
               round(100.0 * count(*) filter (where public.attended_wam(rc.group_id, p_season, rc.week, r.user_id))
                     / nullif(count(*), 0))::int as pct
        from recent rc join roster r on r.group_id = rc.group_id
        group by rc.group_id
      ) a, cs, season
      where season.status = 'active' and a.pct < cs.attendance_threshold
    union all
    select m.group_id, 'missed_wams',
           format('%s missed the last %s WAMs.', public.member_name(m.user_id), m.streak)
      from (
        select r.group_id, r.user_id, max(cs.missed_streak) as streak
        from roster r join held h on h.group_id = r.group_id, cs
        where h.rn <= cs.missed_streak
        group by r.group_id, r.user_id
        having count(*) = max(cs.missed_streak)
           and bool_and(not public.attended_wam(r.group_id, p_season, h.week, r.user_id))
      ) m, season
      where season.status = 'active'
    union all
    select gs.id, 'no_checkins', 'No check-ins last week.'
      from gs, season
      where season.status = 'active' and public.current_season_week(p_season) >= 2
        and not exists (
          select 1 from public.checkins k join roster r on r.user_id = k.user_id and r.group_id = gs.id
          where k.cycle_id = p_season and k.week = public.current_season_week(p_season) - 1
        )
    union all
    select p.group_id, 'pulse_concern',
           format('%s: %s (week %s).', public.member_name(p.member_id),
                  case p.rating when 'not_working' then 'not working' when 'so_so' then 'so-so' else 'working well' end
                    || case when p.wants_help then ', would like help' else '' end,
                  p.week)
      from public.pulses p join gs on gs.id = p.group_id
      where p_named and p.cycle_id = p_season and (p.rating = 'not_working' or p.wants_help)
    union all
    select p.group_id, 'pulse_concern',
           format('%s pulse%s not working or ask%s for help.', count(*),
                  case when count(*) = 1 then ' says' else 's say' end,
                  case when count(*) = 1 then 's' else '' end)
      from public.pulses p join gs on gs.id = p.group_id
      where not p_named and p.cycle_id = p_season and (p.rating = 'not_working' or p.wants_help)
      group by p.group_id
    union all
    select t.from_group_id, 'transfer_request', format('%s asked to transfer.', public.member_name(t.member_id))
      from public.transfer_requests t join gs on gs.id = t.from_group_id
      where t.cycle_id = p_season and t.status = 'open'
  )
  select f.id, gs.name, f.flag, f.detail
  from flags f join gs on gs.id = f.id
$$;
revoke execute on function public.compute_health_flags(uuid, uuid, boolean) from public, anon, authenticated;

-- One group's flags, for its commander (pulse concerns counted, not named)
-- or a club manager.
create or replace function public.group_health_flags(p_group uuid, p_season uuid)
returns table (flag text, detail text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see its health flags';
  end if;
  return query
    select f.flag, f.detail from public.compute_health_flags(p_season, p_group, public.is_admin()) f;
end
$$;

-- Every flag in a season, for club managers.
create or replace function public.season_health_flags(p_season uuid)
returns table (group_id uuid, group_name text, flag text, detail text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see every group''s health';
  end if;
  return query select * from public.compute_health_flags(p_season, null, true) order by 2, 3;
end
$$;

-- What needs a club manager's attention this season, at a glance.
create or replace function public.club_overview(p_season uuid)
returns table (unplaced integer, without_commander integer, below_minimum integer,
               open_transfers integer, at_risk integer, groups integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see the club overview';
  end if;
  return query
    with f as (select * from public.compute_health_flags(p_season, null, true))
    select
      (select count(*)::int from public.unplaced_members(p_season)),
      (select count(distinct f.group_id)::int from f where f.flag = 'no_commander'),
      (select count(distinct f.group_id)::int from f where f.flag = 'below_minimum'),
      (select count(*)::int from public.transfer_requests t where t.cycle_id = p_season and t.status = 'open'),
      (select count(distinct f.group_id)::int from f),
      (select count(*)::int from public.group_seasons gs where gs.cycle_id = p_season and not gs.dormant);
end
$$;

-- ---------- At-risk notices ----------
create table public.group_risk_state (
  group_id uuid not null,
  cycle_id uuid not null,
  at_risk boolean not null,
  foreign key (group_id, cycle_id) references public.group_seasons(group_id, cycle_id) on delete cascade,
  primary key (group_id, cycle_id)
);
alter table public.group_risk_state enable row level security;

-- Re-evaluates a group in an active season; tells club managers when it
-- turns at risk (once per transition, not on every change).
create or replace function public.refresh_group_risk(p_group uuid, p_season uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_first record;
  v_was boolean;
  v_manager uuid;
begin
  if p_group is null or p_season is null
     or not exists (select 1 from public.cycles where id = p_season and status = 'active')
     or not exists (select 1 from public.group_seasons where group_id = p_group and cycle_id = p_season) then
    return;
  end if;
  select at_risk into v_was from public.group_risk_state where group_id = p_group and cycle_id = p_season;
  select f.group_name, f.detail into v_first
    from public.compute_health_flags(p_season, p_group, true) f order by f.flag limit 1;

  if v_first.detail is not null and not coalesce(v_was, false) then
    for v_manager in select id from public.profiles where is_admin loop
      perform public.notify(v_manager, 'at_risk',
        format('%s is now at risk: %s', v_first.group_name, v_first.detail), 'view_health',
        jsonb_build_object('group_id', p_group, 'season_id', p_season));
    end loop;
  end if;
  insert into public.group_risk_state (group_id, cycle_id, at_risk)
    values (p_group, p_season, v_first.detail is not null)
    on conflict (group_id, cycle_id) do update set at_risk = excluded.at_risk;
end
$$;
revoke execute on function public.refresh_group_risk(uuid, uuid) from public, anon, authenticated;

-- Fired by changes to anything a health flag depends on.
create or replace function public.health_changed()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v jsonb := to_jsonb(coalesce(new, old));
begin
  perform public.refresh_group_risk(
    coalesce(v ->> 'group_id', v ->> 'from_group_id')::uuid, (v ->> 'cycle_id')::uuid);
  return null;
end
$$;

create trigger group_members_health after insert or update or delete on public.group_members
  for each row execute function public.health_changed();
create trigger group_seasons_health after update on public.group_seasons
  for each row execute function public.health_changed();
create trigger placement_offers_health after insert or update on public.placement_offers
  for each row execute function public.health_changed();
create trigger attendance_health after insert or update on public.attendance_confirmations
  for each row execute function public.health_changed();
create trigger rsvps_health after insert or delete on public.rsvps
  for each row execute function public.health_changed();
create trigger pulses_health after insert or update on public.pulses
  for each row execute function public.health_changed();
create trigger transfer_requests_health after insert or update on public.transfer_requests
  for each row execute function public.health_changed();

-- A group in an active season losing its commander.
create or replace function public.commander_lost()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_manager uuid;
begin
  if exists (select 1 from public.cycles where id = new.cycle_id and status = 'active') then
    for v_manager in select id from public.profiles where is_admin loop
      perform public.notify(v_manager, 'lost_commander',
        format('%s no longer has a group commander.', (select name from public.groups where id = new.group_id)),
        'view_health', jsonb_build_object('group_id', new.group_id, 'season_id', new.cycle_id));
    end loop;
  end if;
  return null;
end
$$;
create trigger group_seasons_commander_lost after update of commander_id on public.group_seasons
  for each row when (old.commander_id is not null and new.commander_id is null)
  execute function public.commander_lost();

-- A check-in can clear (or not) a group's "no check-ins" flag.
create or replace function public.checkin_health_changed()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_group uuid;
begin
  select group_id into v_group from public.group_members
    where user_id = new.user_id and cycle_id = new.cycle_id and status = 'on_roster';
  perform public.refresh_group_risk(v_group, new.cycle_id);
  return null;
end
$$;
create trigger checkins_health after insert or update on public.checkins
  for each row execute function public.checkin_health_changed();
