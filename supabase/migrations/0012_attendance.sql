-- ============================================================
-- 0012 — RSVPs, attendance and missed WAMs
-- Everyone is presumed attending; only "can't make it" is stored. After a
-- WAM the group commander confirms who attended; until then the RSVPs
-- stand. Cancelled WAMs are left out of attendance altogether.
-- ============================================================

create table public.rsvps (
  group_id uuid not null,
  cycle_id uuid not null,
  week integer not null check (week between 1 and 12),
  member_id uuid not null references public.profiles(id) on delete cascade,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  foreign key (group_id, cycle_id) references public.group_seasons(group_id, cycle_id) on delete cascade,
  primary key (group_id, cycle_id, week, member_id)
);

create table public.attendance_confirmations (
  group_id uuid not null,
  cycle_id uuid not null,
  week integer not null check (week between 1 and 12),
  attendees uuid[] not null default '{}',
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  foreign key (group_id, cycle_id) references public.group_seasons(group_id, cycle_id) on delete cascade,
  primary key (group_id, cycle_id, week)
);

alter table public.rsvps enable row level security;
alter table public.attendance_confirmations enable row level security;
create policy "rsvps_own" on public.rsvps for select to authenticated using (member_id = auth.uid());

-- Internal: did a member take part in a held WAM? The commander's confirmed
-- list if there is one; otherwise presumed, unless they said they couldn't.
create or replace function public.attended_wam(p_group uuid, p_season uuid, p_week integer, p_member uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select p_member = any(a.attendees) from public.attendance_confirmations a
      where a.group_id = p_group and a.cycle_id = p_season and a.week = p_week),
    not exists (select 1 from public.rsvps r
      where r.group_id = p_group and r.cycle_id = p_season and r.week = p_week and r.member_id = p_member)
  )
$$;

-- A member says whether they can make a WAM (attending removes the "can't").
create or replace function public.set_rsvp(p_group uuid, p_season uuid, p_week integer, p_attending boolean, p_note text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.group_members
    where group_id = p_group and cycle_id = p_season and user_id = auth.uid() and status = 'on_roster'
  ) then
    raise exception 'You are not on this group''s roster this season';
  end if;
  if p_attending then
    delete from public.rsvps
      where group_id = p_group and cycle_id = p_season and week = p_week and member_id = auth.uid();
  else
    insert into public.rsvps (group_id, cycle_id, week, member_id, note)
      values (p_group, p_season, p_week, auth.uid(), nullif(btrim(p_note), ''))
      on conflict (group_id, cycle_id, week, member_id) do update set note = excluded.note, created_at = now();
  end if;
end
$$;

-- How many of the roster expect to attend a WAM, for its commander.
create or replace function public.expected_attendance(p_group uuid, p_season uuid, p_week integer)
returns integer
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see expected attendance';
  end if;
  return (
    select count(*)::int from public.group_members m
    where m.group_id = p_group and m.cycle_id = p_season and m.status = 'on_roster'
      and not exists (select 1 from public.rsvps r
        where r.group_id = p_group and r.cycle_id = p_season and r.week = p_week and r.member_id = m.user_id)
  );
end
$$;

-- Every member's RSVP and attendance for each held WAM, for the commander.
-- `attended` is null for WAMs that haven't happened yet.
create or replace function public.wam_attendance(p_group uuid, p_season uuid)
returns table (week integer, member_id uuid, can_attend boolean, note text, attended boolean, confirmed boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see attendance';
  end if;
  return query
    select w.week, m.user_id, r.member_id is null, r.note,
           case when w.starts_at <= now() or a.week is not null
             then public.attended_wam(p_group, p_season, w.week, m.user_id) end,
           a.week is not null
    from public.season_wams(p_group, p_season) w
    join public.group_members m on m.group_id = p_group and m.cycle_id = p_season and m.status = 'on_roster'
    left join public.rsvps r on r.group_id = p_group and r.cycle_id = p_season and r.week = w.week and r.member_id = m.user_id
    left join public.attendance_confirmations a on a.group_id = p_group and a.cycle_id = p_season and a.week = w.week
    where not w.cancelled;
end
$$;

-- The signed-in member's attendance for WAMs already held.
create or replace function public.my_attendance()
returns table (group_id uuid, cycle_id uuid, week integer, starts_at timestamptz, attended boolean)
language sql stable security definer set search_path = public
as $$
  select w.group_id, w.cycle_id, w.week, w.starts_at,
         public.attended_wam(w.group_id, w.cycle_id, w.week, auth.uid())
  from public.my_wams() w
  where not w.cancelled and w.starts_at <= now()
$$;

-- The commander confirms who attended a WAM. Anyone whose misses now reach
-- two held WAMs in a row is flagged to the commander (or club managers).
create or replace function public.confirm_attendance(p_group uuid, p_season uuid, p_week integer, p_attendees uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_member record;
  v_prev integer;
  v_before integer;
  v_group text;
  v_recipient uuid;
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can confirm attendance';
  end if;
  if (select cancelled from public.season_wams(p_group, p_season) where week = p_week) then
    raise exception 'That WAM was cancelled';
  end if;
  insert into public.attendance_confirmations (group_id, cycle_id, week, attendees, confirmed_by)
    values (p_group, p_season, p_week, coalesce(p_attendees, '{}'), auth.uid())
    on conflict (group_id, cycle_id, week) do update
      set attendees = excluded.attendees, confirmed_by = excluded.confirmed_by, confirmed_at = now();

  -- The two held WAMs before this one.
  select max(w.week) into v_prev from public.season_wams(p_group, p_season) w
    where w.week < p_week and not w.cancelled;
  select max(w.week) into v_before from public.season_wams(p_group, p_season) w
    where w.week < v_prev and not w.cancelled;
  if v_prev is null then
    return;
  end if;
  select name into v_group from public.groups where id = p_group;

  for v_member in
    select m.user_id, coalesce(nullif(p.full_name, ''), p.email) as name
    from public.group_members m join public.profiles p on p.id = m.user_id
    where m.group_id = p_group and m.cycle_id = p_season and m.status = 'on_roster'
      and not (m.user_id = any(coalesce(p_attendees, '{}')))
      and not public.attended_wam(p_group, p_season, v_prev, m.user_id)
      and (v_before is null or public.attended_wam(p_group, p_season, v_before, m.user_id))
  loop
    for v_recipient in
      select commander_id from public.group_seasons
        where group_id = p_group and cycle_id = p_season and commander_id is not null
      union
      select id from public.profiles where is_admin
        and not exists (select 1 from public.group_seasons
          where group_id = p_group and cycle_id = p_season and commander_id is not null)
    loop
      perform public.notify(v_recipient, 'missed_wams',
        format('%s has missed 2 %s WAMs in a row.', v_member.name, v_group),
        'view_attendance', jsonb_build_object('group_id', p_group, 'season_id', p_season, 'member_id', v_member.user_id));
    end loop;
  end loop;
end
$$;
