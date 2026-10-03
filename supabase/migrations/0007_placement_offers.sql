-- ============================================================
-- 0007 — Placement offers: invitations (and, later, join requests)
-- A pending offer expires 7 days after it was sent, or when its season
-- starts if it was sent before then. Expiry is worked out on read.
-- ============================================================

-- ---------- When a season started ----------
alter table public.cycles add column activated_at timestamptz;
update public.cycles set activated_at = now() where status in ('active', 'archived');

create or replace function public.stamp_season_activation()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' and new.activated_at is null then
    new.activated_at := now();
  end if;
  return new;
end
$$;
create trigger cycles_stamp_activation
  before update on public.cycles
  for each row execute function public.stamp_season_activation();

-- ---------- Offers ----------
create table public.placement_offers (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('invitation', 'join_request')),
  group_id uuid not null,
  cycle_id uuid not null,
  member_id uuid not null references public.profiles(id) on delete cascade,
  sent_by uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  foreign key (group_id, cycle_id) references public.group_seasons(group_id, cycle_id) on delete cascade
);
create index placement_offers_member_idx on public.placement_offers(member_id, cycle_id);
create index placement_offers_group_idx on public.placement_offers(group_id, cycle_id);

-- Reads go through the functions below; no direct access.
alter table public.placement_offers enable row level security;

-- An offer's status as people see it: pending offers can have expired.
create or replace function public.offer_status(p_offer public.placement_offers)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when p_offer.status <> 'pending' then p_offer.status
    when p_offer.sent_at < now() - interval '7 days' then 'expired'
    when exists (
      select 1 from public.cycles c
      where c.id = p_offer.cycle_id and c.activated_at is not null and c.activated_at > p_offer.sent_at
    ) then 'expired'
    else 'pending'
  end
$$;

create or replace function public.is_commander_of(p_group uuid, p_season uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.group_seasons
    where group_id = p_group and cycle_id = p_season and commander_id = auth.uid()
  )
$$;

-- Internal: an offer can only go to a member not yet placed that season,
-- for a group that still has an open place.
create or replace function public.check_offer_possible(p_group uuid, p_season uuid, p_member uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.group_members
    where user_id = p_member and cycle_id = p_season and status <> 'departed'
  ) then
    raise exception 'That member is already on a roster this season';
  end if;
  if (select vacancies from public.season_groups where id = p_group and cycle_id = p_season) = 0 then
    raise exception 'This group has no open places';
  end if;
end
$$;
revoke execute on function public.check_offer_possible(uuid, uuid, uuid) from public, anon, authenticated;

-- A group commander invites an unplaced member to their group.
create or replace function public.send_invitation(p_group uuid, p_season uuid, p_member uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_offer uuid;
  v_group text;
  v_season text;
begin
  if not public.is_commander_of(p_group, p_season) then
    raise exception 'Only the group''s commander can send invitations';
  end if;
  perform public.check_offer_possible(p_group, p_season, p_member);
  update public.placement_offers o set status = 'withdrawn', responded_at = now()
    where o.kind = 'invitation' and o.group_id = p_group and o.cycle_id = p_season
      and o.member_id = p_member and public.offer_status(o) = 'pending';
  insert into public.placement_offers (kind, group_id, cycle_id, member_id, sent_by)
    values ('invitation', p_group, p_season, p_member, auth.uid()) returning id into v_offer;

  select g.name, c.name into v_group, v_season
    from public.groups g, public.cycles c where g.id = p_group and c.id = p_season;
  perform public.notify(
    p_member, 'invitation',
    format('%s invited you to join %s for %s.',
      (select full_name from public.profiles where id = auth.uid()), v_group, v_season),
    'review_offers', jsonb_build_object('offer_id', v_offer)
  );
  return v_offer;
end
$$;

-- A member answers an invitation (or, later, a commander a join request).
-- Accepting places the member and withdraws their other pending offers.
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
  end if;
end
$$;

-- A group commander withdraws a pending invitation.
create or replace function public.withdraw_offer(p_offer uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.placement_offers;
begin
  select * into v from public.placement_offers where id = p_offer;
  if v.id is null or not (
    (v.kind = 'invitation' and public.is_commander_of(v.group_id, v.cycle_id))
    or (v.kind = 'join_request' and v.member_id = auth.uid())
  ) then
    raise exception 'Only whoever sent it can withdraw this';
  end if;
  update public.placement_offers set status = 'withdrawn', responded_at = now()
    where id = p_offer and status = 'pending';
end
$$;

-- The signed-in member's offers, with what they need to decide.
create or replace function public.my_offers()
returns table (
  id uuid, kind text, status text, sent_at timestamptz, cycle_id uuid, season_name text,
  group_id uuid, group_name text, emoji text, purpose text, wam_time text, commander_name text, vacancies integer
)
language sql stable security definer set search_path = public
as $$
  select o.id, o.kind, public.offer_status(o), o.sent_at, o.cycle_id, c.name,
         sg.id, sg.name, sg.emoji, sg.purpose,
         public.slot_label(sg.slot_mow, public.my_timezone(), c.start_date),
         sg.commander_name, sg.vacancies
  from public.placement_offers o
  join public.cycles c on c.id = o.cycle_id
  join public.season_groups sg on sg.id = o.group_id and sg.cycle_id = o.cycle_id
  where o.member_id = auth.uid()
$$;

-- A group's offers for a season, for its commander or a club manager.
create or replace function public.group_offers(p_group uuid, p_season uuid)
returns table (id uuid, kind text, status text, sent_at timestamptz, member_id uuid, member_name text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see its offers';
  end if;
  return query
    select o.id, o.kind, public.offer_status(o), o.sent_at, o.member_id,
           coalesce(nullif(p.full_name, ''), p.email)
    from public.placement_offers o join public.profiles p on p.id = o.member_id
    where o.group_id = p_group and o.cycle_id = p_season
    order by o.sent_at desc;
end
$$;
