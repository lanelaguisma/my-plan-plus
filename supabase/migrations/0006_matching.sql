-- ============================================================
-- 0006 — Unplaced pool, suggested matches, "What I'm looking for"
-- Matching is transparent: availability for the group's WAM time, then
-- the member's preferred time, then open places. A person always makes
-- the final choice.
-- ============================================================

alter table public.profiles
  add column looking_for text not null default '' check (char_length(looking_for) <= 300);

-- A weekly slot (UTC minute-of-week) as a day and time in a time zone, for
-- the week a season starts (so daylight saving matches that season).
create or replace function public.slot_label(p_slot integer, p_timezone text, p_reference date)
returns text
language sql stable set search_path = public
as $$
  select to_char(
    ((date_trunc('week', p_reference::timestamp) + p_slot * interval '1 minute') at time zone 'UTC')
      at time zone coalesce(nullif(p_timezone, ''), 'UTC'),
    'Dy FMHH12:MI AM')
$$;

-- The signed-in person's time zone, for labels written for them.
create or replace function public.my_timezone()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(nullif(timezone, ''), 'UTC') from public.profiles where id = auth.uid()
$$;

-- Members with availability who are on no roster for the season.
create or replace function public.unplaced_members(p_season uuid)
returns table (member_id uuid, full_name text, email text, timezone text, looking_for text, slots jsonb, preferred_slot integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can list unplaced members';
  end if;
  return query
    select p.id, p.full_name, p.email, p.timezone, p.looking_for, p.slots, p.preferred_slot
    from public.profiles p
    where jsonb_array_length(p.slots) > 0
      and not exists (
        select 1 from public.group_members r
        where r.user_id = p.id and r.cycle_id = p_season and r.status <> 'departed'
      )
    order by p.full_name;
end
$$;

-- Groups with vacancies whose WAM time a member can attend, best first.
create or replace function public.suggested_groups(p_member uuid, p_season uuid)
returns table (group_id uuid, name text, preferred boolean, vacancies integer, capacity integer, reason text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see suggested groups';
  end if;
  return query
    select sg.id, sg.name, (p.preferred_slot = sg.slot_mow), sg.vacancies, sg.capacity,
           format('Available %s%s · %s of %s places open',
             public.slot_label(sg.slot_mow, public.my_timezone(), c.start_date),
             case when p.preferred_slot = sg.slot_mow then ' ★ preferred' else '' end,
             sg.vacancies, sg.capacity)
    from public.season_groups sg
    join public.cycles c on c.id = sg.cycle_id
    join public.profiles p on p.id = p_member
    where sg.cycle_id = p_season and not sg.dormant and sg.vacancies > 0
      and p.slots @> to_jsonb(sg.slot_mow)
    order by (p.preferred_slot = sg.slot_mow) desc nulls last, sg.vacancies desc, sg.name;
end
$$;

-- The unplaced pool as a group commander may see it: only while their group
-- has a vacancy in an enrolling or active season, and never emails or plans.
create or replace function public.prospective_members(p_group uuid, p_season uuid)
returns table (member_id uuid, full_name text, timezone text, available boolean, preferred boolean, looking_for text, reason text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_group record;
begin
  select sg.*, c.start_date, c.status as season_status into v_group
    from public.season_groups sg join public.cycles c on c.id = sg.cycle_id
    where sg.id = p_group and sg.cycle_id = p_season;
  if v_group.commander_id is distinct from auth.uid() then
    raise exception 'Only the group''s commander can browse prospective members';
  end if;
  if v_group.vacancies = 0 or v_group.season_status not in ('enrolling', 'active') then
    return;
  end if;
  return query
    select u.member_id, u.full_name, u.timezone,
           (u.slots @> to_jsonb(v_group.slot_mow)),
           coalesce(u.preferred_slot = v_group.slot_mow, false),
           u.looking_for,
           case when u.slots @> to_jsonb(v_group.slot_mow)
             then format('Available %s%s', public.slot_label(v_group.slot_mow, public.my_timezone(), v_group.start_date),
                         case when u.preferred_slot = v_group.slot_mow then ' ★ preferred' else '' end)
             else 'Not available at this group''s WAM time'
           end
    from (
      select p.id as member_id, p.full_name, p.timezone, p.looking_for, p.slots, p.preferred_slot
      from public.profiles p
      where jsonb_array_length(p.slots) > 0
        and not exists (
          select 1 from public.group_members r
          where r.user_id = p.id and r.cycle_id = p_season and r.status <> 'departed'
        )
    ) u
    order by (u.slots @> to_jsonb(v_group.slot_mow)) desc,
             coalesce(u.preferred_slot = v_group.slot_mow, false) desc, u.full_name;
end
$$;

-- Club managers hear when a placed member's availability stops including
-- their group's WAM time, in an enrolling or active season.
create or replace function public.notice_availability_mismatch()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v record;
  v_manager uuid;
begin
  for v in
    select sg.name as group_name, c.name as season_name, sg.id as group_id, c.id as season_id
    from public.group_members r
    join public.season_groups sg on sg.id = r.group_id and sg.cycle_id = r.cycle_id
    join public.cycles c on c.id = r.cycle_id
    where r.user_id = new.id and r.status <> 'departed' and c.status in ('enrolling', 'active')
      and old.slots @> to_jsonb(sg.slot_mow) and not new.slots @> to_jsonb(sg.slot_mow)
  loop
    for v_manager in select id from public.profiles where is_admin loop
      perform public.notify(
        v_manager, 'availability_mismatch',
        format('%s''s availability no longer includes %s''s WAM time (%s).',
               coalesce(nullif(new.full_name, ''), new.email), v.group_name, v.season_name),
        'view_registrants',
        jsonb_build_object('member_id', new.id, 'group_id', v.group_id, 'season_id', v.season_id)
      );
    end loop;
  end loop;
  return new;
end
$$;

create trigger profiles_availability_mismatch
  after update of slots on public.profiles
  for each row when (old.slots is distinct from new.slots)
  execute function public.notice_availability_mismatch();
