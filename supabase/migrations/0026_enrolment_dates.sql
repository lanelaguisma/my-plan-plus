-- ============================================================
-- 0026 — Planned enrolment dates
-- Enrolment is still opened and closed by hand; these dates only say
-- when it is due, so reminders can count down to them. A club manager
-- can set either date; otherwise it is worked out: enrolment opens at
-- the start of week 11 of the season before, and closes the day before
-- the season starts.
-- ============================================================

alter table public.cycles
  add column enrolment_opens_on date,
  add column enrolment_closes_on date;

create or replace function public.season_enrolment_dates(p_season uuid)
returns table (opens_on date, closes_on date)
language sql stable security definer set search_path = public
as $$
  select coalesce(c.enrolment_opens_on,
                  (select p.start_date + 70 from public.cycles p
                    where p.start_date < c.start_date order by p.start_date desc limit 1)),
         coalesce(c.enrolment_closes_on, c.start_date - 1)
  from public.cycles c
  where c.id = p_season
$$;
grant execute on function public.season_enrolment_dates(uuid) to authenticated;

-- Null clears an override, returning that date to the worked-out one.
create or replace function public.set_season_enrolment_dates(p_season uuid, p_opens_on date, p_closes_on date)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a club manager can set enrolment dates';
  end if;
  if p_opens_on is not null and p_closes_on is not null and p_opens_on > p_closes_on then
    raise exception 'Enrolment must open before it closes';
  end if;
  update public.cycles set enrolment_opens_on = p_opens_on, enrolment_closes_on = p_closes_on
   where id = p_season;
  if not found then
    raise exception 'Season not found';
  end if;
end
$$;
grant execute on function public.set_season_enrolment_dates(uuid, date, date) to authenticated;
