-- ============================================================
-- 0003 — Group profile, size rules and group state
-- ============================================================

-- ---------- Club settings (exactly one row) ----------
create table public.club_settings (
  id boolean primary key default true check (id),
  min_size integer not null default 3 check (min_size > 0),
  capacity integer not null default 4 check (capacity > 0)
);
insert into public.club_settings default values;

alter table public.club_settings enable row level security;
create policy "club_settings_select" on public.club_settings
  for select to authenticated using (true);
create policy "club_settings_admin_update" on public.club_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Group profile ----------
alter table public.groups
  add column emoji text not null default '',
  add column purpose text not null default '' check (char_length(purpose) <= 500),
  add column capacity_override integer check (capacity_override > 0);

-- The old per-group "typical size" becomes an override only where it
-- differed from the club-wide capacity.
update public.groups set capacity_override = max_size where max_size <> 4;

drop view public.season_groups;
alter table public.groups drop column max_size;

-- Only club managers create and edit groups now.
drop policy "groups_insert" on public.groups;
drop policy "groups_update" on public.groups;
drop policy "groups_delete" on public.groups;
create policy "groups_admin_write" on public.groups
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Season groups: profile plus derived state ----------
-- state: dormant (set by a club manager), forming (below minimum size or no
-- group commander) or active. Never stored.
create view public.season_groups as
  with base as (
    select g.id, g.name, g.emoji, g.purpose, g.slot_mow, g.wam_link, g.created_by, g.created_at,
           g.capacity_override, gs.cycle_id, gs.commander_id, gs.dormant,
           coalesce(g.capacity_override, cs.capacity) as capacity, cs.min_size,
           (select count(*)::int from public.group_members r
             where r.group_id = g.id and r.cycle_id = gs.cycle_id and r.status <> 'departed') as member_count
    from public.groups g
    join public.group_seasons gs on gs.group_id = g.id
    cross join public.club_settings cs
  )
  select b.id, b.name, b.emoji, b.purpose, b.slot_mow, b.wam_link, b.created_by, b.created_at,
         b.capacity_override, b.cycle_id, b.commander_id, b.dormant, b.capacity, b.member_count,
         greatest(b.capacity - b.member_count, 0) as vacancies,
         c.full_name as commander_name,
         case
           when b.dormant then 'dormant'
           when b.member_count < b.min_size or b.commander_id is null then 'forming'
           else 'active'
         end as state
  from base b
  left join public.profiles c on c.id = b.commander_id;
revoke all on public.season_groups from anon;
grant select on public.season_groups to authenticated;

-- A club manager pauses (or revives) a group for one season.
create or replace function public.set_group_dormant(p_group uuid, p_season uuid, p_dormant boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can set a group dormant';
  end if;
  update public.group_seasons set dormant = p_dormant
    where group_id = p_group and cycle_id = p_season;
  if not found then
    raise exception 'That group is not running in that season';
  end if;
end
$$;

-- Groups are created by club managers only; members are placed onto them.
create or replace function public.create_season_group(
  p_season uuid, p_name text, p_slot integer, p_members uuid[] default '{}'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_group uuid;
  v_member uuid;
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can create a group';
  end if;
  if exists (
    select 1 from public.group_members
    where cycle_id = p_season and user_id = any(p_members) and status <> 'departed'
  ) then
    raise exception 'Someone in this group is already on a roster this season';
  end if;

  insert into public.groups (name, slot_mow, created_by)
    values (p_name, p_slot, auth.uid()) returning id into v_group;
  insert into public.group_seasons (group_id, cycle_id) values (v_group, p_season);
  foreach v_member in array p_members loop
    insert into public.group_members (group_id, cycle_id, user_id) values (v_group, p_season, v_member);
  end loop;
  return v_group;
end
$$;
