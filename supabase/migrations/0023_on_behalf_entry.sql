-- ============================================================
-- 0023 — On-behalf entry
-- A group commander (for their roster) or a club manager (for anyone) can
-- record a weekly check-in score, a "can't make it" RSVP, or availability
-- and preferences for a member. Each entry says who made it, the member is
-- told, and the member's own write always replaces it.
-- ============================================================

alter table public.checkins add column entered_by uuid references public.profiles(id) on delete set null;
alter table public.rsvps add column entered_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column preferences_entered_by uuid references public.profiles(id) on delete set null;

-- A member's own write clears "entered by".
create or replace function public.clear_entered_by_on_own_write()
returns trigger
language plpgsql
as $$
declare
  v_owner uuid := (to_jsonb(new) ->> TG_ARGV[0])::uuid;
begin
  if auth.uid() is not null and auth.uid() = v_owner then
    new.entered_by := null;
  end if;
  return new;
end
$$;
create trigger checkins_own_write before insert or update on public.checkins
  for each row execute function public.clear_entered_by_on_own_write('user_id');
create trigger rsvps_own_write before insert or update on public.rsvps
  for each row execute function public.clear_entered_by_on_own_write('member_id');

create or replace function public.clear_preferences_entered_by()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and auth.uid() = new.id
     and (new.slots is distinct from old.slots or new.preferred_slot is distinct from old.preferred_slot
          or new.looking_for is distinct from old.looking_for) then
    new.preferences_entered_by := null;
  end if;
  if auth.uid() is not null and new.preferences_entered_by is distinct from old.preferences_entered_by
     and new.preferences_entered_by is not null
     and coalesce(current_setting('app.entering_on_behalf', true), '') <> 'on' then
    raise exception 'Use update_preferences_for to enter preferences for someone';
  end if;
  return new;
end
$$;
create trigger profiles_clear_preferences_entered_by before update on public.profiles
  for each row execute function public.clear_preferences_entered_by();

-- May the signed-in person enter things for this member in this season?
-- Their current group's commander, or any club manager.
create or replace function public.can_enter_for(p_member uuid, p_season uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is distinct from p_member and (public.is_admin() or exists (
    select 1 from public.group_members r
    where r.user_id = p_member and r.cycle_id = p_season and r.status <> 'departed'
      and public.is_commander_of(r.group_id, p_season)
  ))
$$;

create or replace function public.enter_checkin_for(p_member uuid, p_season uuid, p_week integer, p_score integer, p_note text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_existing public.checkins;
begin
  if not public.can_enter_for(p_member, p_season) then
    raise exception 'Only the member''s group commander or a club manager can enter a check-in for them';
  end if;
  if p_week is null or p_week not between 1 and 13 then
    raise exception 'Choose a week from 1 to 13';
  end if;
  if p_score is null or p_score not between 0 and 100 then
    raise exception 'A score is a percentage from 0 to 100';
  end if;
  select * into v_existing from public.checkins where user_id = p_member and cycle_id = p_season and week = p_week;
  if v_existing.user_id is not null and v_existing.entered_by is null then
    raise exception '% has already checked in for week %', public.member_name(p_member), p_week;
  end if;
  insert into public.checkins (user_id, cycle_id, week, score, author_name, reflections, entered_by, updated_at)
    values (p_member, p_season, p_week, p_score, public.member_name(p_member),
            case when nullif(btrim(p_note), '') is null then '{}'::jsonb
                 else jsonb_build_object('entered_note', btrim(p_note)) end,
            auth.uid(), now())
    on conflict (user_id, cycle_id, week) do update
      set score = excluded.score, reflections = excluded.reflections, entered_by = excluded.entered_by, updated_at = now();
  perform public.notify(p_member, 'entered_for_you',
    format('%s logged a %s%% check-in for week %s for you%s. Record your own check-in any time to replace it.',
           public.member_name(auth.uid()), p_score, p_week, coalesce(' ("' || nullif(btrim(p_note), '') || '")', '')),
    'view_checkin', jsonb_build_object('season_id', p_season, 'week', p_week, 'entered_by', auth.uid()));
end
$$;

create or replace function public.set_rsvp_for(p_member uuid, p_group uuid, p_season uuid, p_week integer, p_attending boolean, p_note text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.group_members
                 where user_id = p_member and group_id = p_group and cycle_id = p_season and status = 'on_roster') then
    raise exception 'That member is not on this group''s roster this season';
  end if;
  if not public.can_enter_for(p_member, p_season) then
    raise exception 'Only the member''s group commander or a club manager can RSVP for them';
  end if;
  if p_attending then
    delete from public.rsvps
      where group_id = p_group and cycle_id = p_season and week = p_week and member_id = p_member;
  else
    insert into public.rsvps (group_id, cycle_id, week, member_id, note, entered_by)
      values (p_group, p_season, p_week, p_member, nullif(btrim(p_note), ''), auth.uid())
      on conflict (group_id, cycle_id, week, member_id) do update
        set note = excluded.note, entered_by = excluded.entered_by, created_at = now();
  end if;
  perform public.notify(p_member, 'entered_for_you',
    format('%s marked you as %s the week %s WAM.', public.member_name(auth.uid()),
           case when p_attending then 'attending' else 'unable to make' end, p_week),
    'view_wams', jsonb_build_object('group_id', p_group, 'season_id', p_season, 'week', p_week, 'entered_by', auth.uid()));
end
$$;

create or replace function public.update_preferences_for(p_member uuid, p_slots jsonb, p_preferred integer, p_looking_for text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (auth.uid() is distinct from p_member and (public.is_admin() or exists (
    select 1 from public.group_members r join public.cycles c on c.id = r.cycle_id
    where r.user_id = p_member and r.status <> 'departed' and c.status in ('enrolling', 'active')
      and public.is_commander_of(r.group_id, r.cycle_id)
  ))) then
    raise exception 'Only the member''s group commander or a club manager can update their preferences';
  end if;
  if jsonb_typeof(coalesce(p_slots, '[]'::jsonb)) <> 'array' then
    raise exception 'Availability must be a list of weekly times';
  end if;
  if p_preferred is not null and not coalesce(p_slots, '[]'::jsonb) @> to_jsonb(p_preferred) then
    raise exception 'The preferred time must be one of the available times';
  end if;
  perform set_config('app.entering_on_behalf', 'on', true);
  update public.profiles
    set slots = coalesce(p_slots, '[]'::jsonb), preferred_slot = p_preferred,
        looking_for = coalesce(btrim(p_looking_for), ''), preferences_entered_by = auth.uid()
    where id = p_member;
  perform set_config('app.entering_on_behalf', '', true);
  perform public.notify(p_member, 'entered_for_you',
    format('%s updated your availability and preferences. Check them under Your Preferences.', public.member_name(auth.uid())),
    'view_group', jsonb_build_object('entered_by', auth.uid()));
end
$$;
