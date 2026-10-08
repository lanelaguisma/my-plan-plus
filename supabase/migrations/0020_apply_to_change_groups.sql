-- ============================================================
-- 0020 — Changing groups by applying
-- A member already on a roster can ask to join another group with an open
-- place. They keep their place until the request is approved; then they
-- move (recorded as a move, not a departure) and both commanders are told.
-- ============================================================

-- Internal: a join request needs an open place, from someone not already on
-- this group's roster, who isn't commanding the group they would leave.
create or replace function public.check_join_possible(p_group uuid, p_season uuid, p_member uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.group_members
    where user_id = p_member and cycle_id = p_season and group_id = p_group and status <> 'departed'
  ) then
    raise exception 'You are already in this group';
  end if;
  if exists (
    select 1 from public.group_seasons
    where cycle_id = p_season and commander_id = p_member and group_id <> p_group
  ) then
    raise exception 'You command your group this season — ask a club manager to hand it over before you move';
  end if;
  if (select vacancies from public.season_groups where id = p_group and cycle_id = p_season) = 0 then
    raise exception 'This group has no open places';
  end if;
end
$$;
revoke execute on function public.check_join_possible(uuid, uuid, uuid) from public, anon, authenticated;

-- The group a member is on this season, if any.
create or replace function public.current_group_of(p_member uuid, p_season uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select group_id from public.group_members
  where user_id = p_member and cycle_id = p_season and status <> 'departed'
$$;
revoke execute on function public.current_group_of(uuid, uuid) from public, anon, authenticated;

create or replace function public.send_join_request(p_group uuid, p_season uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_offer uuid;
  v_commander uuid;
  v_message text;
  v_recipient uuid;
  v_from text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  perform public.check_join_possible(p_group, p_season, auth.uid());
  update public.placement_offers o set status = 'withdrawn', responded_at = now()
    where o.kind = 'join_request' and o.group_id = p_group and o.cycle_id = p_season
      and o.member_id = auth.uid() and public.offer_status(o) = 'pending';
  insert into public.placement_offers (kind, group_id, cycle_id, member_id, sent_by)
    values ('join_request', p_group, p_season, auth.uid(), auth.uid()) returning id into v_offer;

  select name into v_from from public.groups where id = public.current_group_of(auth.uid(), p_season);
  select gs.commander_id, format('%s%s asked to join %s for %s.',
           coalesce(nullif(p.full_name, ''), p.email),
           coalesce(' (currently in ' || v_from || ')', ''), g.name, c.name)
    into v_commander, v_message
    from public.group_seasons gs
    join public.groups g on g.id = gs.group_id
    join public.cycles c on c.id = gs.cycle_id
    join public.profiles p on p.id = auth.uid()
    where gs.group_id = p_group and gs.cycle_id = p_season;
  -- A group without a commander yet: its club managers decide.
  for v_recipient in
    select v_commander where v_commander is not null
    union all
    select id from public.profiles where is_admin and v_commander is null
  loop
    perform public.notify(v_recipient, 'join_request', v_message, 'review_join_requests',
      jsonb_build_object('offer_id', v_offer, 'group_id', p_group, 'season_id', p_season));
  end loop;
  return v_offer;
end
$$;

-- Redefined so an approved join request can move a member between groups.
create or replace function public.respond_to_offer(p_offer uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.placement_offers;
  v_member_name text;
  v_group text;
  v_from uuid;
  v_from_commander uuid;
begin
  select * into v from public.placement_offers where id = p_offer for update;
  if v.id is null then
    raise exception 'That offer does not exist';
  end if;
  if v.kind = 'invitation' and v.member_id is distinct from auth.uid() then
    raise exception 'Only the invited member can answer an invitation';
  end if;
  if v.kind = 'join_request' and not (public.is_commander_of(v.group_id, v.cycle_id) or public.is_admin()) then
    raise exception 'Only the group''s commander can answer a join request';
  end if;
  if public.offer_status(v) <> 'pending' then
    raise exception 'This % is no longer open (%)', replace(v.kind, '_', ' '), public.offer_status(v);
  end if;

  if p_accept then
    if v.kind = 'join_request' then
      perform public.check_join_possible(v.group_id, v.cycle_id, v.member_id);
      v_from := public.current_group_of(v.member_id, v.cycle_id);
      select commander_id into v_from_commander from public.group_seasons
        where group_id = v_from and cycle_id = v.cycle_id;
    else
      perform public.check_offer_possible(v.group_id, v.cycle_id, v.member_id);
    end if;
    perform public.place_on_roster(v.member_id, v.group_id, v.cycle_id);
    update public.placement_offers o set status = 'withdrawn', responded_at = now()
      where o.member_id = v.member_id and o.cycle_id = v.cycle_id and o.id <> v.id
        and public.offer_status(o) = 'pending';
    -- Moving resolves any open transfer request.
    update public.transfer_requests set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
      where member_id = v.member_id and cycle_id = v.cycle_id and status = 'open';
  end if;
  update public.placement_offers
    set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
    where id = v.id;

  select coalesce(nullif(p.full_name, ''), p.email), g.name into v_member_name, v_group
    from public.profiles p, public.groups g where p.id = v.member_id and g.id = v.group_id;
  if v.kind = 'invitation' and v.sent_by is not null then
    perform public.notify(
      v.sent_by, 'invitation_answered',
      format('%s %s your invitation to %s.', v_member_name, case when p_accept then 'accepted' else 'declined' end, v_group),
      null, jsonb_build_object('offer_id', v.id)
    );
  elsif v.kind = 'join_request' then
    perform public.notify(
      v.member_id, 'join_request_answered',
      format('Your request to join %s was %s.', v_group, case when p_accept then 'approved' else 'declined' end),
      case when p_accept then 'view_group' end, jsonb_build_object('offer_id', v.id)
    );
    if v_from_commander is not null then
      perform public.notify(
        v_from_commander, 'member_moved',
        format('%s moved from %s to %s.', v_member_name, (select name from public.groups where id = v_from), v_group),
        'view_group', jsonb_build_object('group_id', v_from, 'season_id', v.cycle_id, 'member_id', v.member_id)
      );
    end if;
  end if;
end
$$;

-- A group's offers, now saying which group a requester is currently in.
drop function public.group_offers(uuid, uuid);
create function public.group_offers(p_group uuid, p_season uuid)
returns table (id uuid, kind text, status text, sent_at timestamptz, member_id uuid, member_name text, current_group text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see its offers';
  end if;
  return query
    select o.id, o.kind, public.offer_status(o), o.sent_at, o.member_id,
           coalesce(nullif(p.full_name, ''), p.email),
           (select g.name from public.groups g where g.id = public.current_group_of(o.member_id, o.cycle_id) and g.id <> p_group)
    from public.placement_offers o join public.profiles p on p.id = o.member_id
    where o.group_id = p_group and o.cycle_id = p_season
    order by o.sent_at desc;
end
$$;
