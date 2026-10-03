-- ============================================================
-- 0014 — The pulse
-- A member's private, one-tap rating of how their group is working for
-- them, in weeks 4, 8 and 13. Club managers see individual pulses; group
-- commanders only see their group's combined counts, and only once at
-- least three people have answered.
-- ============================================================

create table public.pulses (
  member_id uuid not null references public.profiles(id) on delete cascade,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  week integer not null check (week in (4, 8, 13)),
  group_id uuid references public.groups(id) on delete set null,
  rating text not null check (rating in ('working', 'so_so', 'not_working')),
  comment text check (char_length(comment) <= 1000),
  wants_help boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (member_id, cycle_id, week)
);
alter table public.pulses enable row level security;
create policy "pulses_own_or_manager" on public.pulses
  for select to authenticated using (member_id = auth.uid() or public.is_admin());

-- The week of a season today is in (1-13), or null outside it.
create or replace function public.current_season_week(p_season uuid)
returns integer
language sql stable security definer set search_path = public
as $$
  select case when w between 1 and 13 then w end
  from (select ((current_date - start_date) / 7) + 1 as w from public.cycles where id = p_season) x
$$;

create or replace function public.submit_pulse(p_season uuid, p_week integer, p_rating text, p_comment text, p_wants_help boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_group uuid;
begin
  if p_week not in (4, 8, 13) then
    raise exception 'The pulse is taken in weeks 4, 8 and 13';
  end if;
  select group_id into v_group from public.group_members
    where user_id = auth.uid() and cycle_id = p_season and status = 'on_roster';
  if v_group is null then
    raise exception 'You are not on a roster this season';
  end if;
  insert into public.pulses (member_id, cycle_id, week, group_id, rating, comment, wants_help)
    values (auth.uid(), p_season, p_week, v_group, p_rating, nullif(btrim(p_comment), ''), coalesce(p_wants_help, false))
    on conflict (member_id, cycle_id, week) do update
      set group_id = excluded.group_id, rating = excluded.rating, comment = excluded.comment,
          wants_help = excluded.wants_help, created_at = now();
end
$$;

-- Every pulse in a season, for club managers.
create or replace function public.season_pulses(p_season uuid)
returns table (member_id uuid, member_name text, group_name text, week integer, rating text,
               comment text, wants_help boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can see individual pulses';
  end if;
  return query
    select p.member_id, coalesce(nullif(pr.full_name, ''), pr.email), g.name, p.week, p.rating,
           p.comment, p.wants_help, p.created_at
    from public.pulses p
    join public.profiles pr on pr.id = p.member_id
    left join public.groups g on g.id = p.group_id
    where p.cycle_id = p_season
    order by p.week desc, p.created_at desc;
end
$$;

-- A group's combined pulse for one week; the breakdown is withheld until
-- at least three members have answered, so no answer can be singled out.
create or replace function public.group_pulse(p_group uuid, p_season uuid, p_week integer)
returns table (responses integer, working integer, so_so integer, not_working integer, wants_help integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (public.is_commander_of(p_group, p_season) or public.is_admin()) then
    raise exception 'Only the group''s commander can see its pulse';
  end if;
  return query
    select n,
           case when n >= 3 then w end, case when n >= 3 then s end,
           case when n >= 3 then nw end, case when n >= 3 then h end
    from (
      select count(*)::int as n,
             count(*) filter (where rating = 'working')::int as w,
             count(*) filter (where rating = 'so_so')::int as s,
             count(*) filter (where rating = 'not_working')::int as nw,
             count(*) filter (where pulses.wants_help)::int as h
      from public.pulses
      where group_id = p_group and cycle_id = p_season and week = p_week
    ) t;
end
$$;

-- A reminder during a pulse week until the member has answered.
create or replace function public.pulse_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select 'pulse:' || r.cycle_id || ':' || wk.week, 'pulse',
         format('How is %s working for you? Week %s pulse — it takes one tap.', g.name, wk.week),
         'answer_pulse',
         jsonb_build_object('season_id', r.cycle_id, 'week', wk.week),
         (c.start_date + 7 * (wk.week - 1))::timestamptz
  from public.group_members r
  join public.cycles c on c.id = r.cycle_id and c.status = 'active'
  join public.groups g on g.id = r.group_id
  cross join lateral (select public.current_season_week(c.id) as week) wk
  where r.user_id = auth.uid() and r.status = 'on_roster' and wk.week in (4, 8, 13)
    and not exists (select 1 from public.pulses p
      where p.member_id = auth.uid() and p.cycle_id = r.cycle_id and p.week = wk.week)
$$;

create or replace function public.derived_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select * from public.continuation_notices()
  union all
  select * from public.wam_reminder_notices()
  union all
  select * from public.pulse_notices()
$$;
