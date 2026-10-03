-- ============================================================
-- 0010 — The WAM schedule
-- A group's WAMs (weeks 1-12) are derived from its season's start date and
-- the group's weekly time and link. Only exceptions are stored.
-- ============================================================

create table public.wam_overrides (
  group_id uuid not null,
  cycle_id uuid not null,
  week integer not null check (week between 1 and 12),
  cancelled boolean not null default false,
  starts_at timestamptz,   -- a one-off new time
  link text,               -- a one-off link
  foreign key (group_id, cycle_id) references public.group_seasons(group_id, cycle_id) on delete cascade,
  primary key (group_id, cycle_id, week)
);
alter table public.wam_overrides enable row level security;
create policy "wam_overrides_select" on public.wam_overrides for select to authenticated using (true);

-- Every WAM of a group in a season, with any one-off changes applied.
create or replace function public.season_wams(p_group uuid, p_season uuid)
returns table (week integer, starts_at timestamptz, link text, cancelled boolean, rescheduled boolean)
language sql stable security definer set search_path = public
as $$
  select w.week,
         coalesce(o.starts_at,
           (c.start_date::timestamp + (w.week - 1) * interval '7 days' + g.slot_mow * interval '1 minute') at time zone 'UTC'),
         coalesce(o.link, g.wam_link),
         coalesce(o.cancelled, false),
         o.starts_at is not null
  from public.group_seasons gs
  join public.groups g on g.id = gs.group_id
  join public.cycles c on c.id = gs.cycle_id
  cross join generate_series(1, 12) as w(week)
  left join public.wam_overrides o on o.group_id = gs.group_id and o.cycle_id = gs.cycle_id and o.week = w.week
  where gs.group_id = p_group and gs.cycle_id = p_season
$$;

-- The signed-in member's WAMs across the groups they are on.
create or replace function public.my_wams()
returns table (group_id uuid, group_name text, cycle_id uuid, season_name text,
               week integer, starts_at timestamptz, link text, cancelled boolean, rescheduled boolean)
language sql stable security definer set search_path = public
as $$
  select r.group_id, g.name, r.cycle_id, c.name, w.week, w.starts_at, w.link, w.cancelled, w.rescheduled
  from public.group_members r
  join public.groups g on g.id = r.group_id
  join public.cycles c on c.id = r.cycle_id
  cross join lateral public.season_wams(r.group_id, r.cycle_id) w
  where r.user_id = auth.uid() and r.status = 'on_roster' and c.status in ('enrolling', 'active')
$$;

-- Internal: tells the rest of a group's roster about a changed WAM, in each
-- member's own time zone.
create or replace function public.notify_wam_changed(p_group uuid, p_season uuid, p_week integer)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_wam record;
  v_member record;
  v_group text;
begin
  select * into v_wam from public.season_wams(p_group, p_season) where week = p_week;
  select name into v_group from public.groups where id = p_group;
  for v_member in
    select p.id, coalesce(nullif(p.timezone, ''), 'UTC') as tz
    from public.group_members r join public.profiles p on p.id = r.user_id
    where r.group_id = p_group and r.cycle_id = p_season and r.status = 'on_roster' and r.user_id <> auth.uid()
  loop
    perform public.notify(
      v_member.id, 'wam_changed',
      case when v_wam.cancelled
        then format('%s''s week %s WAM is cancelled.', v_group, p_week)
        else format('%s''s week %s WAM moved to %s.', v_group, p_week,
               to_char(v_wam.starts_at at time zone v_member.tz, 'Dy FMDD Mon, FMHH12:MI AM'))
      end,
      'view_wams', jsonb_build_object('group_id', p_group, 'season_id', p_season, 'week', p_week)
    );
  end loop;
end
$$;
revoke execute on function public.notify_wam_changed(uuid, uuid, integer) from public, anon, authenticated;

-- A group commander (or club manager) moves one WAM; the regular time stays.
create or replace function public.reschedule_wam(p_group uuid, p_season uuid, p_week integer, p_starts_at timestamptz, p_link text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can change a WAM';
  end if;
  insert into public.wam_overrides (group_id, cycle_id, week, starts_at, link, cancelled)
    values (p_group, p_season, p_week, p_starts_at, nullif(p_link, ''), false)
    on conflict (group_id, cycle_id, week) do update
      set starts_at = excluded.starts_at, link = excluded.link, cancelled = false;
  perform public.notify_wam_changed(p_group, p_season, p_week);
end
$$;

-- A group commander (or club manager) calls off one WAM.
create or replace function public.cancel_wam(p_group uuid, p_season uuid, p_week integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can change a WAM';
  end if;
  insert into public.wam_overrides (group_id, cycle_id, week, cancelled)
    values (p_group, p_season, p_week, true)
    on conflict (group_id, cycle_id, week) do update set cancelled = true;
  perform public.notify_wam_changed(p_group, p_season, p_week);
end
$$;

-- ---------- Derived notices, one function per kind ----------
create or replace function public.continuation_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select 'continuation:' || r.cycle_id || ':' || r.group_id, 'continuation',
         format('Are you continuing with %s for %s? Please confirm.', g.name, c.name),
         'confirm_continuation',
         jsonb_build_object('group_id', r.group_id, 'season_id', r.cycle_id),
         r.joined_at
  from public.group_members r
  join public.groups g on g.id = r.group_id
  join public.cycles c on c.id = r.cycle_id
  where r.user_id = auth.uid() and r.status = 'awaiting_continuation' and c.status = 'enrolling'
$$;

-- A reminder in the 24 hours before each of the member's WAMs.
create or replace function public.wam_reminder_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select 'wam:' || w.group_id || ':' || w.cycle_id || ':' || w.week, 'wam_reminder',
         format('%s''s WAM is coming up: %s.', w.group_name,
                to_char(w.starts_at at time zone public.my_timezone(), 'Dy FMHH12:MI AM')),
         'join_wam',
         jsonb_build_object('group_id', w.group_id, 'season_id', w.cycle_id, 'week', w.week, 'link', w.link),
         w.starts_at - interval '24 hours'
  from public.my_wams() w
  where not w.cancelled and w.starts_at > now() and w.starts_at <= now() + interval '24 hours'
$$;

create or replace function public.derived_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select * from public.continuation_notices()
  union all
  select * from public.wam_reminder_notices()
$$;
