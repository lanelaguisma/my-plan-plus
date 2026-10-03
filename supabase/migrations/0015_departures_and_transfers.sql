-- ============================================================
-- 0015 — Leaving, departures and transfer requests
-- Roster entries are never deleted: leaving or a recorded departure marks
-- them departed, so a group's history keeps the weeks a member was in it.
-- ============================================================

-- Members no longer delete their own roster entries; they leave.
drop policy "group_members_delete" on public.group_members;
create policy "group_members_delete" on public.group_members
  for delete to authenticated using (public.is_admin());

-- Internal: marks a member departed from their roster for a season, drops
-- any commander role, and returns the group they left (null if none).
create or replace function public.depart_roster(p_member uuid, p_season uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_group uuid;
begin
  update public.group_members
    set status = 'departed', departed_at = now(), departure_reason = p_reason
    where user_id = p_member and cycle_id = p_season and status <> 'departed'
    returning group_id into v_group;
  update public.group_seasons set commander_id = null
    where cycle_id = p_season and commander_id = p_member;
  return v_group;
end
$$;
revoke execute on function public.depart_roster(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.member_name(p_member uuid)
returns text
language sql stable security definer set search_path = public
as $$ select coalesce(nullif(full_name, ''), email) from public.profiles where id = p_member $$;

-- A member leaves their group mid-season; they become unplaced at once.
create or replace function public.leave_group(p_season uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_group uuid;
  v_commander uuid;
begin
  v_group := public.depart_roster(auth.uid(), p_season, 'left');
  if v_group is null then
    raise exception 'You are not on a roster this season';
  end if;
  update public.transfer_requests set status = 'cancelled', resolved_at = now()
    where member_id = auth.uid() and cycle_id = p_season and status = 'open';
  select commander_id into v_commander from public.group_seasons where group_id = v_group and cycle_id = p_season;
  if v_commander is not null then
    perform public.notify(v_commander, 'member_left',
      format('%s left %s.', public.member_name(auth.uid()), (select name from public.groups where id = v_group)),
      'view_group', jsonb_build_object('group_id', v_group, 'season_id', p_season, 'member_id', auth.uid()));
  end if;
end
$$;

-- A group commander records that a member has left their group; club
-- managers are told and can reverse it.
create or replace function public.record_departure(p_member uuid, p_group uuid, p_season uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_manager uuid;
begin
  if not public.is_commander_of(p_group, p_season) then
    raise exception 'Only the group''s commander can record a departure';
  end if;
  if not exists (select 1 from public.group_members
    where user_id = p_member and group_id = p_group and cycle_id = p_season and status <> 'departed') then
    raise exception 'That member is not on your roster';
  end if;
  perform public.depart_roster(p_member, p_season, coalesce(nullif(btrim(p_reason), ''), 'departed'));
  for v_manager in select id from public.profiles where is_admin loop
    perform public.notify(v_manager, 'departure_recorded',
      format('%s recorded that %s left %s (%s).', public.member_name(auth.uid()), public.member_name(p_member),
             (select name from public.groups where id = p_group), coalesce(nullif(btrim(p_reason), ''), 'no reason given')),
      'review_departures',
      jsonb_build_object('member_id', p_member, 'group_id', p_group, 'season_id', p_season));
  end loop;
end
$$;

-- A club manager puts a departed member back on the roster they left.
create or replace function public.reverse_departure(p_member uuid, p_group uuid, p_season uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can reverse a departure';
  end if;
  if exists (select 1 from public.group_members
    where user_id = p_member and cycle_id = p_season and status <> 'departed') then
    raise exception 'That member is already on a roster this season';
  end if;
  update public.group_members
    set status = 'on_roster', departed_at = null, departure_reason = null
    where user_id = p_member and group_id = p_group and cycle_id = p_season and status = 'departed';
  if not found then
    raise exception 'No departure to reverse';
  end if;
end
$$;

-- Recent departures in a season, for club managers.
create or replace function public.season_departures(p_season uuid)
returns table (member_id uuid, member_name text, group_id uuid, group_name text, reason text, departed_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see departures';
  end if;
  return query
    select r.user_id, public.member_name(r.user_id), r.group_id, g.name, r.departure_reason, r.departed_at
    from public.group_members r join public.groups g on g.id = r.group_id
    where r.cycle_id = p_season and r.status = 'departed' and r.departure_reason <> 'moved'
    order by r.departed_at desc;
end
$$;

-- ---------- Transfer requests ----------
create table public.transfer_requests (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  from_group_id uuid references public.groups(id) on delete set null,
  reason text check (char_length(reason) <= 1000),
  status text not null default 'open' check (status in ('open', 'resolved', 'cancelled')),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz
);
create unique index transfer_requests_one_open on public.transfer_requests(member_id, cycle_id) where status = 'open';
alter table public.transfer_requests enable row level security;
create policy "transfer_requests_own_or_manager" on public.transfer_requests
  for select to authenticated using (member_id = auth.uid() or public.is_admin());

-- A member asks a club manager to move them; they stay put until then.
create or replace function public.request_transfer(p_season uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_group uuid;
  v_id uuid;
  v_manager uuid;
begin
  select group_id into v_group from public.group_members
    where user_id = auth.uid() and cycle_id = p_season and status = 'on_roster';
  if v_group is null then
    raise exception 'You are not on a roster this season';
  end if;
  update public.transfer_requests set status = 'cancelled', resolved_at = now()
    where member_id = auth.uid() and cycle_id = p_season and status = 'open';
  insert into public.transfer_requests (member_id, cycle_id, from_group_id, reason)
    values (auth.uid(), p_season, v_group, nullif(btrim(p_reason), '')) returning id into v_id;
  for v_manager in select id from public.profiles where is_admin loop
    perform public.notify(v_manager, 'transfer_request',
      format('%s asked to move from %s%s', public.member_name(auth.uid()),
             (select name from public.groups where id = v_group),
             coalesce(': ' || nullif(btrim(p_reason), ''), '.')),
      'review_transfers', jsonb_build_object('request_id', v_id, 'season_id', p_season));
  end loop;
  return v_id;
end
$$;

create or replace function public.cancel_transfer_request(p_season uuid)
returns void
language sql security definer set search_path = public
as $$
  update public.transfer_requests set status = 'cancelled', resolved_at = now()
    where member_id = auth.uid() and cycle_id = p_season and status = 'open'
$$;

-- A club manager closes a request without moving the member.
create or replace function public.resolve_transfer_request(p_request uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can resolve a transfer request';
  end if;
  update public.transfer_requests set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
    where id = p_request and status = 'open';
end
$$;

create or replace function public.open_transfer_requests(p_season uuid)
returns table (id uuid, member_id uuid, member_name text, from_group text, reason text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see transfer requests';
  end if;
  return query
    select t.id, t.member_id, public.member_name(t.member_id), g.name, t.reason, t.created_at
    from public.transfer_requests t left join public.groups g on g.id = t.from_group_id
    where t.cycle_id = p_season and t.status = 'open'
    order by t.created_at;
end
$$;

-- Assigning a member elsewhere resolves their open transfer request.
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
    update public.transfer_requests set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
      where member_id = p_member and cycle_id = p_season and status = 'open';
  end if;
end
$$;

-- ---------- A group's check-in history ----------
-- Each member's check-ins for the weeks they were on the group's roster:
-- from the week they joined until the week they left.
create or replace function public.group_checkins(p_group uuid, p_season uuid)
returns table (user_id uuid, week integer, score integer, author_name text, reflections jsonb)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_on_group(p_group) or public.is_admin()) then
    raise exception 'Only the group''s members can see its check-ins';
  end if;
  return query
    select k.user_id, k.week, k.score, k.author_name, k.reflections
    from public.checkins k
    join public.group_members r on r.user_id = k.user_id and r.group_id = p_group and r.cycle_id = p_season
    join public.cycles c on c.id = p_season
    where k.cycle_id = p_season
      and (c.start_date + 7 * k.week)::timestamptz > r.joined_at
      and (r.departed_at is null or (c.start_date + 7 * (k.week - 1))::timestamptz < r.departed_at);
end
$$;
