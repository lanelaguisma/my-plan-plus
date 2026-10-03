-- ============================================================
-- 0011 — Changing a group's regular WAM time
-- A group commander proposes; a club manager approves (or changes it
-- directly). WAMs already held keep their time; later ones move.
-- ============================================================

create table public.wam_time_proposals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  slot_mow integer not null check (slot_mow between 0 and 10079),
  proposed_by uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz
);
alter table public.wam_time_proposals enable row level security;
create policy "wam_time_proposals_select" on public.wam_time_proposals
  for select to authenticated using (public.is_admin() or proposed_by = auth.uid());

-- Internal: moves a group's regular WAM time. WAMs that have already started
-- in running seasons are pinned to their old time first.
create or replace function public.apply_wam_time(p_group uuid, p_slot integer)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_member record;
  v_group text;
begin
  insert into public.wam_overrides (group_id, cycle_id, week, starts_at)
    select gs.group_id, gs.cycle_id, w.week, w.starts_at
    from public.group_seasons gs
    join public.cycles c on c.id = gs.cycle_id and c.status in ('enrolling', 'active')
    cross join lateral public.season_wams(gs.group_id, gs.cycle_id) w
    where gs.group_id = p_group and w.starts_at <= now() and not w.rescheduled
    on conflict (group_id, cycle_id, week) do update set starts_at = excluded.starts_at;

  update public.groups set slot_mow = p_slot where id = p_group returning name into v_group;

  for v_member in
    select distinct p.id, p.timezone
    from public.group_members r
    join public.cycles c on c.id = r.cycle_id and c.status in ('enrolling', 'active')
    join public.profiles p on p.id = r.user_id
    where r.group_id = p_group and r.status <> 'departed'
  loop
    perform public.notify(
      v_member.id, 'wam_time_changed',
      format('%s''s WAM time is now %s.', v_group, public.slot_label(p_slot, v_member.timezone, current_date)),
      'view_wams', jsonb_build_object('group_id', p_group)
    );
  end loop;
end
$$;
revoke execute on function public.apply_wam_time(uuid, integer) from public, anon, authenticated;

-- A club manager sets a group's regular WAM time directly.
create or replace function public.set_wam_time(p_group uuid, p_slot integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can change a group''s WAM time';
  end if;
  perform public.apply_wam_time(p_group, p_slot);
end
$$;

-- A group commander proposes a new regular WAM time for their group.
create or replace function public.propose_wam_time(p_group uuid, p_slot integer)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_manager uuid;
  v_message text;
begin
  if not exists (
    select 1 from public.group_seasons gs join public.cycles c on c.id = gs.cycle_id
    where gs.group_id = p_group and gs.commander_id = auth.uid() and c.status in ('enrolling', 'active')
  ) then
    raise exception 'Only the group''s commander can propose a new WAM time';
  end if;
  update public.wam_time_proposals set status = 'declined', decided_at = now()
    where group_id = p_group and status = 'pending';
  insert into public.wam_time_proposals (group_id, slot_mow, proposed_by)
    values (p_group, p_slot, auth.uid()) returning id into v_id;

  select format('%s proposes moving %s''s WAM to %s (UTC).',
           coalesce(nullif(p.full_name, ''), p.email), g.name, public.slot_label(p_slot, 'UTC', current_date))
    into v_message
    from public.profiles p, public.groups g where p.id = auth.uid() and g.id = p_group;
  for v_manager in select id from public.profiles where is_admin loop
    perform public.notify(v_manager, 'wam_time_proposal', v_message, 'review_wam_time',
      jsonb_build_object('proposal_id', v_id, 'group_id', p_group, 'slot_mow', p_slot));
  end loop;
  return v_id;
end
$$;

-- A club manager approves or declines a proposal.
create or replace function public.decide_wam_time(p_proposal uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.wam_time_proposals;
  v_group text;
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can decide on a WAM time change';
  end if;
  select * into v from public.wam_time_proposals where id = p_proposal and status = 'pending' for update;
  if v.id is null then
    raise exception 'That proposal is no longer pending';
  end if;
  update public.wam_time_proposals
    set status = case when p_approve then 'approved' else 'declined' end, decided_by = auth.uid(), decided_at = now()
    where id = v.id;
  if p_approve then
    perform public.apply_wam_time(v.group_id, v.slot_mow);
  end if;
  select name into v_group from public.groups where id = v.group_id;
  if v.proposed_by is not null then
    perform public.notify(v.proposed_by, 'wam_time_decided',
      format('Your proposal to move %s''s WAM time was %s.', v_group, case when p_approve then 'approved' else 'declined' end),
      null, jsonb_build_object('proposal_id', v.id));
  end if;
end
$$;

-- Pending proposals, for club managers.
create or replace function public.pending_wam_time_proposals()
returns table (id uuid, group_id uuid, group_name text, proposed_by_name text, slot_mow integer, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can review WAM time proposals';
  end if;
  return query
    select w.id, w.group_id, g.name, coalesce(nullif(p.full_name, ''), p.email), w.slot_mow, w.created_at
    from public.wam_time_proposals w
    join public.groups g on g.id = w.group_id
    left join public.profiles p on p.id = w.proposed_by
    where w.status = 'pending' order by w.created_at;
end
$$;
