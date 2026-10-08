-- ============================================================
-- 0024 — Minimum size: club default 2, per-group override
-- The club-wide minimum drops to 2. A club manager or the group's
-- commander can override it for their group (2 up to its capacity); the
-- override belongs to the group, so it carries from season to season.
-- ============================================================

alter table public.club_settings alter column min_size set default 2;
update public.club_settings set min_size = 2 where min_size = 3;

alter table public.groups
  add column min_size_override integer check (min_size_override >= 2),
  add column min_size_set_by uuid references public.profiles(id) on delete set null,
  add column min_size_set_at timestamptz;

-- ---------- Season groups use the group's effective minimum ----------
create or replace view public.season_groups as
  with base as (
    select g.id, g.name, g.emoji, g.purpose, g.slot_mow, g.wam_link, g.created_by, g.created_at,
           g.capacity_override, gs.cycle_id, gs.commander_id, gs.dormant,
           coalesce(g.capacity_override, cs.capacity) as capacity,
           coalesce(g.min_size_override, cs.min_size) as min_size, g.min_size_override, g.min_size_set_by,
           (select count(*)::int from public.pending_members pm
             where pm.group_id = g.id and pm.cycle_id = gs.cycle_id and pm.status = 'pending') as pending_count,
           (select count(*)::int from public.group_members r
             where r.group_id = g.id and r.cycle_id = gs.cycle_id and r.status <> 'departed') as roster_count
    from public.groups g
    join public.group_seasons gs on gs.group_id = g.id
    cross join public.club_settings cs
  )
  select b.id, b.name, b.emoji, b.purpose, b.slot_mow, b.wam_link, b.created_by, b.created_at,
         b.capacity_override, b.cycle_id, b.commander_id, b.dormant, b.capacity,
         b.roster_count + b.pending_count as member_count,
         greatest(b.capacity - b.roster_count - b.pending_count, 0) as vacancies,
         c.full_name as commander_name,
         case
           when b.dormant then 'dormant'
           when b.roster_count + b.pending_count < b.min_size or b.commander_id is null then 'forming'
           else 'active'
         end as state,
         b.pending_count,
         b.min_size, b.min_size_override, b.min_size_set_by
  from base b
  left join public.profiles c on c.id = b.commander_id;

-- ---------- Health flags use the effective minimum ----------
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
                  case when gs.member_count = 1 then '' else 's' end, gs.min_size)
      from gs, cs where gs.member_count < gs.min_size
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
                  (select count(*) from roster r where r.group_id = gs.id), gs.min_size)
      from gs, cs, season
      where season.status = 'enrolling'
        and (select count(*) from roster r where r.group_id = gs.id) < gs.min_size
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

-- ---------- Setting the override ----------
-- A club manager, or the group's commander for a running or enrolling
-- season, sets the group's minimum; null returns it to the club default.
create or replace function public.set_group_min_size(p_group uuid, p_size integer)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_capacity integer;
  s record;
begin
  if not (public.is_admin() or exists (
    select 1 from public.group_seasons gs join public.cycles c on c.id = gs.cycle_id
    where gs.group_id = p_group and gs.commander_id = auth.uid() and c.status in ('active', 'enrolling')
  )) then
    raise exception 'Only a club manager or this group''s commander can change its minimum size';
  end if;
  select coalesce(g.capacity_override, cs.capacity) into v_capacity
    from public.groups g cross join public.club_settings cs where g.id = p_group;
  if v_capacity is null then
    raise exception 'Group not found';
  end if;
  if p_size is not null and (p_size < 2 or p_size > v_capacity) then
    raise exception 'Minimum size must be between 2 and the group''s capacity (%)', v_capacity;
  end if;
  update public.groups
     set min_size_override = p_size,
         min_size_set_by = case when p_size is null then null else auth.uid() end,
         min_size_set_at = case when p_size is null then null else now() end
   where id = p_group;
  for s in select gs.cycle_id from public.group_seasons gs join public.cycles c on c.id = gs.cycle_id
           where gs.group_id = p_group and c.status = 'active' loop
    perform public.refresh_group_risk(p_group, s.cycle_id);
  end loop;
end
$$;
grant execute on function public.set_group_min_size(uuid, integer) to authenticated;
