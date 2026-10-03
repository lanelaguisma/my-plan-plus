-- ============================================================
-- 0005 — Assignment and the in-app inbox
-- Every placement goes through someone accountable; members no longer
-- put themselves on a roster. Notices tell people what happened.
-- ============================================================

-- ---------- Roster changes ----------
-- Members no longer insert their own roster entries.
drop policy "group_members_insert" on public.group_members;
create policy "group_members_insert" on public.group_members
  for insert to authenticated with check (public.is_admin());

-- Puts a member on a group's roster for a season, moving them off any other
-- roster that season (kept as a departed entry). Internal: callers check
-- permissions. Returns false when the member was already on that roster.
create or replace function public.place_on_roster(p_member uuid, p_group uuid, p_season uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.group_members
    where group_id = p_group and cycle_id = p_season and user_id = p_member and status <> 'departed'
  ) then
    return false;
  end if;
  update public.group_members
    set status = 'departed', departed_at = now(), departure_reason = 'moved'
    where cycle_id = p_season and user_id = p_member and status <> 'departed';
  update public.group_seasons set commander_id = null
    where cycle_id = p_season and commander_id = p_member and group_id <> p_group;
  insert into public.group_members (group_id, cycle_id, user_id)
    values (p_group, p_season, p_member)
    on conflict (group_id, cycle_id, user_id) do update
      set status = 'on_roster', joined_at = now(), departed_at = null, departure_reason = null;
  return true;
end
$$;
revoke execute on function public.place_on_roster(uuid, uuid, uuid) from public, anon, authenticated;

-- A club manager assigns a member to a group for a season (capacity may be
-- exceeded), moving them if they are already placed elsewhere.
create or replace function public.assign_member(p_member uuid, p_group uuid, p_season uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can assign members';
  end if;
  perform public.place_on_roster(p_member, p_group, p_season);
end
$$;

-- A club manager takes a member off their roster for a season.
create or replace function public.remove_from_roster(p_member uuid, p_season uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can remove members';
  end if;
  update public.group_members
    set status = 'departed', departed_at = now(), departure_reason = 'removed by a club manager'
    where cycle_id = p_season and user_id = p_member and status <> 'departed';
  update public.group_seasons gs set commander_id = null
    where gs.cycle_id = p_season and gs.commander_id = p_member;
end
$$;

-- ---------- Inbox ----------
-- Event notices are stored when something happens. Time-based notices are
-- derived on read (see derived_notices); their read state is kept by key.
create table public.notices (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  message text not null,
  action text,               -- what the member can do about it, if anything
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notices_recipient_idx on public.notices(recipient_id, created_at desc);

create table public.notice_reads (
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  key text not null,
  read_at timestamptz not null default now(),
  primary key (recipient_id, key)
);

alter table public.notices enable row level security;
alter table public.notice_reads enable row level security;
create policy "notices_own" on public.notices
  for select to authenticated using (recipient_id = auth.uid());
create policy "notice_reads_own" on public.notice_reads
  for select to authenticated using (recipient_id = auth.uid());

-- Internal: writes an event notice.
create or replace function public.notify(
  p_recipient uuid, p_kind text, p_message text, p_action text default null, p_payload jsonb default '{}'::jsonb
)
returns void
language sql security definer set search_path = public
as $$
  insert into public.notices (recipient_id, kind, message, action, payload)
  values (p_recipient, p_kind, p_message, p_action, p_payload)
$$;
revoke execute on function public.notify(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- Time-based notices for the signed-in member, computed from current state.
-- Later migrations replace this as new kinds are added.
create or replace function public.derived_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select null::text, null::text, null::text, null::text, null::jsonb, null::timestamptz where false
$$;

create or replace function public.my_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz, read boolean)
language sql stable security definer set search_path = public
as $$
  select 'n:' || n.id, n.kind, n.message, n.action, n.payload, n.created_at, n.read_at is not null
    from public.notices n where n.recipient_id = auth.uid()
  union all
  select d.key, d.kind, d.message, d.action, d.payload, d.created_at,
         exists (select 1 from public.notice_reads r where r.recipient_id = auth.uid() and r.key = d.key)
    from public.derived_notices() d
$$;

create or replace function public.unread_notice_count()
returns integer
language sql stable security definer set search_path = public
as $$
  select count(*)::int from public.my_notices() where not read
$$;

create or replace function public.mark_notice_read(p_key text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_key like 'n:%' then
    update public.notices set read_at = coalesce(read_at, now())
      where id = substring(p_key from 3)::uuid and recipient_id = auth.uid();
  else
    insert into public.notice_reads (recipient_id, key) values (auth.uid(), p_key)
      on conflict do nothing;
  end if;
end
$$;

-- Internal: tells a member which group they have been placed in.
create or replace function public.notify_assigned(p_member uuid, p_group uuid, p_season uuid)
returns void
language sql security definer set search_path = public
as $$
  select public.notify(
    p_member, 'assigned',
    format('You''ve been assigned to %s for %s.', g.name, c.name),
    'view_group',
    jsonb_build_object('group_id', g.id, 'season_id', c.id)
  )
  from public.groups g, public.cycles c
  where g.id = p_group and c.id = p_season
$$;
revoke execute on function public.notify_assigned(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.assign_member(p_member uuid, p_group uuid, p_season uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can assign members';
  end if;
  if public.place_on_roster(p_member, p_group, p_season) then
    perform public.notify_assigned(p_member, p_group, p_season);
  end if;
end
$$;

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
    perform public.notify_assigned(v_member, v_group, p_season);
  end loop;
  return v_group;
end
$$;
