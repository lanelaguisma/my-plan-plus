-- ============================================================
-- 0019 — Pending members
-- A group commander (for their group) or a club manager (for any group)
-- can hold a place on a roster for someone who hasn't registered yet. The
-- place counts toward the group's size, and becomes a normal roster entry
-- when that person signs up with the same email.
-- ============================================================

create table public.pending_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  cycle_id uuid not null,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  added_by uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'registered', 'cancelled')),
  member_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (group_id, cycle_id) references public.group_seasons(group_id, cycle_id) on delete cascade
);
create unique index pending_members_one_per_season
  on public.pending_members(email, cycle_id) where status = 'pending';
create index pending_members_group_idx on public.pending_members(group_id, cycle_id);

-- Pending emails are seen only by whoever added them, the group's commander
-- and club managers. Writes go through the functions below.
alter table public.pending_members enable row level security;
create policy "pending_members_select" on public.pending_members
  for select to authenticated using (
    added_by = auth.uid() or public.is_admin() or public.is_commander_of(group_id, cycle_id)
  );

-- ---------- Season groups count pending members ----------
-- member_count is the roster size including pending members (it drives
-- capacity, vacancies, group state and health flags); pending_count says
-- how many of those are still to register.
create or replace view public.season_groups as
  with base as (
    select g.id, g.name, g.emoji, g.purpose, g.slot_mow, g.wam_link, g.created_by, g.created_at,
           g.capacity_override, gs.cycle_id, gs.commander_id, gs.dormant,
           coalesce(g.capacity_override, cs.capacity) as capacity, cs.min_size,
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
         b.pending_count
  from base b
  left join public.profiles c on c.id = b.commander_id;

-- ---------- Adding and cancelling ----------
create or replace function public.add_pending_member(p_group uuid, p_season uuid, p_name text, p_email text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander or a club manager can add a pending member';
  end if;
  if not exists (select 1 from public.cycles where id = p_season and status in ('setup', 'enrolling', 'active')) then
    raise exception 'That season is over';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'Enter their name';
  end if;
  if exists (select 1 from public.profiles where lower(email) = v_email) then
    raise exception 'That person is already registered — invite them from Prospective Members instead';
  end if;
  if exists (select 1 from public.pending_members
             where email = v_email and cycle_id = p_season and status = 'pending') then
    raise exception 'That email is already pending in a group this season';
  end if;
  if not public.is_admin()
     and (select vacancies from public.season_groups where id = p_group and cycle_id = p_season) = 0 then
    raise exception 'This group has no open places';
  end if;
  insert into public.pending_members (group_id, cycle_id, full_name, email, added_by)
    values (p_group, p_season, btrim(p_name), v_email, auth.uid()) returning id into v_id;
  return v_id;
end
$$;

create or replace function public.cancel_pending_member(p_pending uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.pending_members;
begin
  select * into v from public.pending_members where id = p_pending;
  if v.id is null or not (public.is_commander_of(v.group_id, v.cycle_id) or public.is_admin()) then
    raise exception 'Only the group''s commander or a club manager can cancel a pending member';
  end if;
  update public.pending_members set status = 'cancelled', resolved_at = now()
    where id = p_pending and status = 'pending';
end
$$;

-- A group's pending members, for its commander or a club manager.
create or replace function public.group_pending_members(p_group uuid, p_season uuid)
returns table (id uuid, full_name text, email text, added_by_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see its pending members';
  end if;
  return query
    select pm.id, pm.full_name, pm.email, public.member_name(pm.added_by), pm.created_at
    from public.pending_members pm
    where pm.group_id = p_group and pm.cycle_id = p_season and pm.status = 'pending'
    order by pm.created_at;
end
$$;

-- ---------- Claiming the place at sign-up ----------
create or replace function public.claim_pending_places(p_member uuid, p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v record;
  v_recipient uuid;
begin
  for v in
    select pm.*, g.name as group_name, gs.commander_id
    from public.pending_members pm
    join public.groups g on g.id = pm.group_id
    join public.group_seasons gs on gs.group_id = pm.group_id and gs.cycle_id = pm.cycle_id
    join public.cycles c on c.id = pm.cycle_id
    where pm.email = lower(btrim(p_email)) and pm.status = 'pending' and c.status <> 'archived'
  loop
    -- The place stops being "pending" before it becomes a roster entry, so
    -- the group is never counted twice.
    update public.pending_members set status = 'registered', member_id = p_member, resolved_at = now()
      where id = v.id;
    perform public.place_on_roster(p_member, v.group_id, v.cycle_id);
    perform public.notify_assigned(p_member, v.group_id, v.cycle_id);
    for v_recipient in
      select v.commander_id where v.commander_id is not null
      union
      select v.added_by where v.added_by is not null
    loop
      perform public.notify(v_recipient, 'pending_registered',
        format('%s registered and is now on the %s roster.', public.member_name(p_member), v.group_name),
        'view_group', jsonb_build_object('group_id', v.group_id, 'season_id', v.cycle_id, 'member_id', p_member));
    end loop;
  end loop;
end
$$;
revoke execute on function public.claim_pending_places(uuid, text) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, invited_by)
  values (
    new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''),
    (select p.id from public.profiles p
      where p.invite_code = nullif(btrim(new.raw_user_meta_data->>'invite_code'), ''))
  )
  on conflict (id) do nothing;
  if new.email is not null then
    perform public.claim_pending_places(new.id, new.email);
  end if;
  return new;
end
$$;

-- Pending places count toward group health.
create trigger pending_members_health after insert or update on public.pending_members
  for each row execute function public.health_changed();
