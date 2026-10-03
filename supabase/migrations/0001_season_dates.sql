-- ============================================================
-- 0001 — Season dates
-- A season (stored in `cycles`) is 13 weeks: 12 scored weeks plus a
-- week-13 break. Week N starts at start_date + 7*(N-1) days.
-- ============================================================

-- The suggested start for a new season: the Monday after the latest
-- season ends (or next Monday when there are no seasons yet).
create or replace function public.suggested_season_start()
returns date
language sql stable security definer set search_path = public
as $$
  select (date_trunc('week', coalesce(max(start_date) + 90, current_date)) + interval '7 days')::date
  from public.cycles
$$;

-- Once a season has started, its start date is locked: moving it would
-- renumber check-ins already recorded. Individual WAMs move instead.
create or replace function public.lock_started_season_start()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('active', 'archived') and new.start_date is distinct from old.start_date then
    raise exception 'The start date is locked once a season has started';
  end if;
  return new;
end
$$;

create trigger cycles_lock_started_start
  before update on public.cycles
  for each row execute function public.lock_started_season_start();

-- Warnings for a proposed season start date: any season it would overlap,
-- and a gap after the previous season or before the next one. Pass the
-- season being edited so it is not compared with itself.
create or replace function public.season_date_warnings(p_start date, p_season uuid default null)
returns table (kind text, other_season text)
language sql stable security definer set search_path = public
as $$
  with others as (
    select name, start_date from public.cycles where id is distinct from p_season
  ),
  previous as (
    select name, start_date from others where start_date + 90 < p_start
    order by start_date desc limit 1
  ),
  following as (
    select name, start_date from others where start_date > p_start + 90
    order by start_date limit 1
  )
  select 'overlap', name from others
    where start_date <= p_start + 90 and p_start <= start_date + 90
  union all
  select 'gap', name from previous where start_date + 91 < p_start
  union all
  select 'gap', name from following where p_start + 91 < start_date
$$;

-- The Monday a given week (1-13) of a season starts; week 13 is the break.
create or replace function public.season_week_start(p_season uuid, p_week integer)
returns date
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_week is null or p_week not between 1 and 13 then
    raise exception 'Week must be between 1 and 13';
  end if;
  return (select start_date + 7 * (p_week - 1) from public.cycles where id = p_season);
end
$$;
