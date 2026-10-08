-- ============================================================
-- 0021 — The club roster
-- Everyone in the club (and everyone with a place held for them) with
-- where they stand in one season, for club managers.
-- ============================================================

-- status: placed (on a roster), awaiting_continuation, unplaced (has
-- availability, on no roster), not_enrolled (no availability, on no roster),
-- departed (left a roster this season and not placed again) or
-- pending_registration (a held place for someone not yet registered).
create or replace function public.club_roster(p_season uuid)
returns table (
  person_id uuid, pending_id uuid, full_name text, email text, status text,
  group_id uuid, group_name text, is_commander boolean, is_club_manager boolean,
  invited_by uuid, invited_by_name text, registered_at timestamptz, departure_reason text
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see the club roster';
  end if;
  return query
    with current_entry as (
      select r.user_id, r.group_id, r.status from public.group_members r
      where r.cycle_id = p_season and r.status <> 'departed'
    ),
    last_departure as (
      select distinct on (r.user_id) r.user_id, r.group_id, r.departure_reason
      from public.group_members r
      where r.cycle_id = p_season and r.status = 'departed' and r.departure_reason <> 'moved'
      order by r.user_id, r.departed_at desc nulls last
    )
    select p.id, null::uuid, p.full_name, p.email,
           case
             when ce.status = 'on_roster' then 'placed'
             when ce.status = 'awaiting_continuation' then 'awaiting_continuation'
             when ld.user_id is not null then 'departed'
             when jsonb_array_length(p.slots) > 0 then 'unplaced'
             else 'not_enrolled'
           end,
           coalesce(ce.group_id, ld.group_id), g.name,
           coalesce(gs.commander_id = p.id, false), p.is_admin,
           p.invited_by, public.member_name(p.invited_by), p.created_at,
           case when ce.user_id is null then ld.departure_reason end
    from public.profiles p
    left join current_entry ce on ce.user_id = p.id
    left join last_departure ld on ld.user_id = p.id and ce.user_id is null
    left join public.groups g on g.id = coalesce(ce.group_id, ld.group_id)
    left join public.group_seasons gs on gs.group_id = ce.group_id and gs.cycle_id = p_season
    union all
    select null, pm.id, pm.full_name, pm.email, 'pending_registration',
           pm.group_id, g.name, false, false, pm.added_by, public.member_name(pm.added_by), null, null
    from public.pending_members pm join public.groups g on g.id = pm.group_id
    where pm.cycle_id = p_season and pm.status = 'pending'
    order by 3;
end
$$;
