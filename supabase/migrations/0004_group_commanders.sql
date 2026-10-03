-- ============================================================
-- 0004 — Group commanders
-- A group commander is the member on a group's roster who operates the
-- group for a season. Club managers appoint, replace or clear them.
-- ============================================================

-- Appoints (or, with a null member, clears) a group's commander for a season.
create or replace function public.appoint_group_commander(p_group uuid, p_season uuid, p_member uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can appoint a group commander';
  end if;
  if p_member is not null and not exists (
    select 1 from public.group_members
    where group_id = p_group and cycle_id = p_season and user_id = p_member and status <> 'departed'
  ) then
    raise exception 'A group commander must be on the group''s roster for the season';
  end if;
  update public.group_seasons set commander_id = p_member
    where group_id = p_group and cycle_id = p_season;
  if not found then
    raise exception 'That group is not running in that season';
  end if;
end
$$;
