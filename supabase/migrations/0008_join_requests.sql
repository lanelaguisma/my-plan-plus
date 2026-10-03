-- ============================================================
-- 0008 — Join requests
-- A member asks to join a group with an open place; that group's
-- commander (or a club manager) approves or declines.
-- ============================================================

create or replace function public.send_join_request(p_group uuid, p_season uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_offer uuid;
  v_commander uuid;
  v_message text;
  v_recipient uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  perform public.check_offer_possible(p_group, p_season, auth.uid());
  update public.placement_offers o set status = 'withdrawn', responded_at = now()
    where o.kind = 'join_request' and o.group_id = p_group and o.cycle_id = p_season
      and o.member_id = auth.uid() and public.offer_status(o) = 'pending';
  insert into public.placement_offers (kind, group_id, cycle_id, member_id, sent_by)
    values ('join_request', p_group, p_season, auth.uid(), auth.uid()) returning id into v_offer;

  select gs.commander_id, format('%s asked to join %s for %s.',
           coalesce(nullif(p.full_name, ''), p.email), g.name, c.name)
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

-- Redefined to tell a member how their join request was answered.
create or replace function public.respond_to_offer(p_offer uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.placement_offers;
  v_member_name text;
  v_group text;
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
    perform public.check_offer_possible(v.group_id, v.cycle_id, v.member_id);
    perform public.place_on_roster(v.member_id, v.group_id, v.cycle_id);
    update public.placement_offers o set status = 'withdrawn', responded_at = now()
      where o.member_id = v.member_id and o.cycle_id = v.cycle_id and o.id <> v.id
        and public.offer_status(o) = 'pending';
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
  end if;
end
$$;
