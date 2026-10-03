-- ============================================================
-- 0002 — Lasting groups (ADR 0001)
-- A group outlives any one season. What belongs to a season moves out of
-- `groups`: a group-season record (group x season) and the roster, which
-- is `group_members` (group x season x member) with a status.
-- ============================================================

-- ---------- Group-season: a group's participation in one season ----------
create table public.group_seasons (
  group_id uuid not null references public.groups(id) on delete cascade,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  commander_id uuid references public.profiles(id) on delete set null,
  dormant boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (group_id, cycle_id)
);
create index group_seasons_cycle_idx on public.group_seasons(cycle_id);

insert into public.group_seasons (group_id, cycle_id)
  select id, cycle_id from public.groups;

-- ---------- Roster entries ----------
alter table public.group_members
  add column status text not null default 'on_roster'
    check (status in ('awaiting_continuation', 'on_roster', 'departed')),
  add column joined_at timestamptz not null default now(),
  add column departed_at timestamptz,
  add column departure_reason text;

alter table public.group_members drop constraint group_members_pkey;
alter table public.group_members add primary key (group_id, cycle_id, user_id);
alter table public.group_members
  add constraint group_members_group_season_fkey
  foreign key (group_id, cycle_id) references public.group_seasons(group_id, cycle_id) on delete cascade;

-- A member is on at most one roster per season (departed entries are history).
drop index public.group_members_one_per_cycle;
create unique index group_members_one_per_season
  on public.group_members(user_id, cycle_id) where status <> 'departed';

-- ---------- Groups no longer belong to one season ----------
alter table public.groups drop column cycle_id;

-- ---------- Group-mates are per season ----------
-- Two people are group-mates in a season when both are on the same group's
-- roster for that season (the viewer not departed). Security definer so
-- policies on group_members/profiles can use it without recursion.
create or replace function public.is_group_mate_in_season(p_other uuid, p_season uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.group_members me
    join public.group_members mate
      on mate.group_id = me.group_id and mate.cycle_id = me.cycle_id
    where me.user_id = auth.uid() and me.status <> 'departed'
      and mate.user_id = p_other and me.cycle_id = p_season
  )
$$;

create or replace function public.is_group_mate(p_other uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.group_members me
    join public.group_members mate
      on mate.group_id = me.group_id and mate.cycle_id = me.cycle_id
    where me.user_id = auth.uid() and me.status <> 'departed' and mate.user_id = p_other
  )
$$;

-- A group's message board belongs to the lasting group: anyone currently on
-- one of its rosters can use it.
create or replace function public.is_on_group(p_group uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = auth.uid() and status <> 'departed'
  )
$$;

drop policy "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (
    id = auth.uid() or public.is_admin() or is_admin or public.is_group_mate(id)
  );

drop policy "checkins_select" on public.checkins;
create policy "checkins_select" on public.checkins
  for select to authenticated using (
    user_id = auth.uid() or public.is_admin() or public.is_group_mate_in_season(user_id, cycle_id)
  );

drop policy "messages_select" on public.messages;
create policy "messages_select" on public.messages
  for select to authenticated using (
    board_id is not null or public.is_admin() or public.is_on_group(group_id)
  );
drop policy "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert to authenticated with check (
    user_id = auth.uid() and (board_id is not null or public.is_admin() or public.is_on_group(group_id))
  );

-- ---------- Row-level security for group-seasons ----------
alter table public.group_seasons enable row level security;
create policy "group_seasons_select" on public.group_seasons
  for select to authenticated using (true);
create policy "group_seasons_admin_write" on public.group_seasons
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Season groups: what a group looks like in one season ----------
create or replace view public.season_groups as
  select g.id, g.name, g.slot_mow, g.wam_link, g.created_by, g.max_size, g.created_at,
         gs.cycle_id, gs.commander_id, gs.dormant,
         (select count(*)::int from public.group_members r
           where r.group_id = g.id and r.cycle_id = gs.cycle_id and r.status <> 'departed') as member_count
  from public.groups g
  join public.group_seasons gs on gs.group_id = g.id;
revoke all on public.season_groups from anon;
grant select on public.season_groups to authenticated;

-- Creates a group running in a season and puts the given people on its
-- roster. Members may create a group only for themselves; club managers
-- may place anyone.
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
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if not public.is_admin() and p_members is distinct from array[auth.uid()] then
    raise exception 'Only a club manager can place other people in a group';
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
