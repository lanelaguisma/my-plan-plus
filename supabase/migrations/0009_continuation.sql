-- ============================================================
-- 0009 — Continuation and the enrolment cut-off
-- Opening enrolment carries every running group's roster into the next
-- season as awaiting continuation. Members confirm or decline; anyone
-- still awaiting when the season starts leaves a vacancy.
-- ============================================================

create or replace function public.open_enrolment(p_season uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_source uuid;
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can open enrolment';
  end if;
  update public.cycles set status = 'setup' where status = 'enrolling' and id <> p_season;
  update public.cycles set status = 'enrolling' where id = p_season and status = 'setup';

  -- Carry over from the season just before this one.
  select prev.id into v_source
    from public.cycles prev, public.cycles target
    where target.id = p_season and prev.start_date < target.start_date
    order by prev.start_date desc limit 1;
  if v_source is null then
    return;
  end if;

  insert into public.group_seasons (group_id, cycle_id, commander_id)
    select gs.group_id, p_season, gs.commander_id
    from public.group_seasons gs
    where gs.cycle_id = v_source and not gs.dormant
    on conflict do nothing;

  insert into public.group_members (group_id, cycle_id, user_id, status)
    select r.group_id, p_season, r.user_id, 'awaiting_continuation'
    from public.group_members r
    join public.group_seasons gs on gs.group_id = r.group_id and gs.cycle_id = r.cycle_id
    where r.cycle_id = v_source and r.status <> 'departed' and not gs.dormant
      and not exists (
        select 1 from public.group_members t
        where t.user_id = r.user_id and t.cycle_id = p_season
      )
    on conflict do nothing;
end
$$;

-- A member confirms (or declines) continuing with their group next season.
create or replace function public.confirm_continuation(p_season uuid, p_continue boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_continue then
    update public.group_members set status = 'on_roster'
      where cycle_id = p_season and user_id = auth.uid() and status = 'awaiting_continuation';
  else
    update public.group_members
      set status = 'departed', departed_at = now(), departure_reason = 'declined to continue'
      where cycle_id = p_season and user_id = auth.uid() and status = 'awaiting_continuation';
  end if;
  if not found then
    raise exception 'You have no continuation to confirm for that season';
  end if;
  if not p_continue then
    update public.group_seasons set commander_id = null
      where cycle_id = p_season and commander_id = auth.uid();
  end if;
end
$$;

-- The cut-off: when a season starts, anyone still awaiting continuation
-- leaves a vacancy, and a commander no longer on the roster loses the role.
create or replace function public.continuation_cut_off()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.group_members
    set status = 'departed', departed_at = now(), departure_reason = 'did not continue'
    where cycle_id = new.id and status = 'awaiting_continuation';
  update public.group_seasons gs set commander_id = null
    where gs.cycle_id = new.id and gs.commander_id is not null
      and not exists (
        select 1 from public.group_members r
        where r.group_id = gs.group_id and r.cycle_id = gs.cycle_id
          and r.user_id = gs.commander_id and r.status <> 'departed'
      );
  return new;
end
$$;
create trigger cycles_continuation_cut_off
  after update of status on public.cycles
  for each row when (new.status = 'active' and old.status is distinct from 'active')
  execute function public.continuation_cut_off();

-- Who has (and hasn't) confirmed, for a group's commander or a club manager.
create or replace function public.group_continuations(p_group uuid, p_season uuid)
returns table (member_id uuid, member_name text, status text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see its continuations';
  end if;
  return query
    select r.user_id, coalesce(nullif(p.full_name, ''), p.email), r.status
    from public.group_members r join public.profiles p on p.id = r.user_id
    where r.group_id = p_group and r.cycle_id = p_season;
end
$$;

-- Continuation progress across every group in a season, for club managers.
create or replace function public.continuation_progress(p_season uuid)
returns table (group_id uuid, group_name text, confirmed integer, awaiting integer, declined integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see continuation progress';
  end if;
  return query
    select g.id, g.name,
      count(*) filter (where r.status = 'on_roster')::int,
      count(*) filter (where r.status = 'awaiting_continuation')::int,
      count(*) filter (where r.status = 'departed' and r.departure_reason in ('declined to continue', 'did not continue'))::int
    from public.group_seasons gs
    join public.groups g on g.id = gs.group_id
    left join public.group_members r on r.group_id = gs.group_id and r.cycle_id = gs.cycle_id
    where gs.cycle_id = p_season
    group by g.id, g.name
    order by g.name;
end
$$;

-- Time-based notices: a reminder while a member's continuation is outstanding.
create or replace function public.derived_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select 'continuation:' || r.cycle_id || ':' || r.group_id, 'continuation',
         format('Are you continuing with %s for %s? Please confirm.', g.name, c.name),
         'confirm_continuation',
         jsonb_build_object('group_id', r.group_id, 'season_id', r.cycle_id),
         r.joined_at
  from public.group_members r
  join public.groups g on g.id = r.group_id
  join public.cycles c on c.id = r.cycle_id
  where r.user_id = auth.uid() and r.status = 'awaiting_continuation' and c.status = 'enrolling'
$$;
