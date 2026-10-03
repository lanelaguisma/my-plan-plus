-- ============================================================
-- Season 24 import — run ONCE by hand in the Supabase SQL Editor, after
-- all migrations. Not a migration: it seeds production data from the
-- "Season 24 Group Tracker" sheet. Safe to re-run (it reuses an existing
-- "Season 24" season and groups of the same names).
--
-- Members are matched to registered accounts by name (case and spacing
-- ignored, exactly one match required). The final result lists tracker
-- members with no matching account: invite them to register, then assign
-- them from the Club Manager Panel. Appoint group commanders afterwards.
-- Check-ins and scores are not imported; the sheet stays their archive.
--
-- WAM times are as the tracker states them in October (daylight time):
-- Friday 4 PM PT = Friday 23:00 UTC; Wednesday 2:30 PM PT = 21:30 UTC.
-- ============================================================

drop table if exists s24_tracker;
create temporary table s24_tracker (group_name text, emoji text, slot_mow integer, member_name text);

insert into s24_tracker values
  ('Fri-Avengers',        '🐴', 4 * 1440 + 23 * 60,      null),
  ('Fri-B',               '🐻', 4 * 1440 + 23 * 60,      'Iain Dunn'),
  ('Fri-B',               '🐻', 4 * 1440 + 23 * 60,      'Cameron Cherry'),
  ('Fri-B',               '🐻', 4 * 1440 + 23 * 60,      'Strong'),
  ('Momentum Collective', '🐧', 4 * 1440 + 23 * 60,      'Kiran Alphonso'),
  ('Momentum Collective', '🐧', 4 * 1440 + 23 * 60,      'Johnson Eung'),
  ('Momentum Collective', '🐧', 4 * 1440 + 23 * 60,      'Eviana'),
  ('Momentum Collective', '🐧', 4 * 1440 + 23 * 60,      'Jack Lee'),
  ('Wed Mavericks',       '🐹', 2 * 1440 + 21 * 60 + 30, 'Sia'),
  ('Wed Mavericks',       '🐹', 2 * 1440 + 21 * 60 + 30, 'Jessica'),
  ('Wed Mavericks',       '🐹', 2 * 1440 + 21 * 60 + 30, 'Shan');

do $$
declare
  v_season uuid;
  v_group record;
  v_group_id uuid;
  v_member uuid;
  v_row record;
begin
  -- The season (reused if it already exists).
  select id into v_season from public.cycles where name = 'Season 24';
  if v_season is null then
    insert into public.cycles (name, start_date, status, activated_at)
      values ('Season 24', '2026-10-05',
              case when exists (select 1 from public.cycles where status = 'active') then 'setup' else 'active' end,
              case when exists (select 1 from public.cycles where status = 'active') then null else now() end)
      returning id into v_season;
  end if;

  -- The lasting groups, each running in Season 24.
  for v_group in select distinct group_name, emoji, slot_mow from s24_tracker loop
    select id into v_group_id from public.groups where name = v_group.group_name;
    if v_group_id is null then
      insert into public.groups (name, emoji, slot_mow)
        values (v_group.group_name, v_group.emoji, v_group.slot_mow) returning id into v_group_id;
    end if;
    insert into public.group_seasons (group_id, cycle_id) values (v_group_id, v_season)
      on conflict do nothing;

    -- Rosters: only tracker members matching exactly one registered account.
    for v_row in select member_name from s24_tracker
                 where group_name = v_group.group_name and member_name is not null loop
      select min(id::text)::uuid into v_member from public.profiles
        where lower(btrim(full_name)) = lower(btrim(v_row.member_name))
        having count(*) = 1;
      if v_member is not null and not exists (
        select 1 from public.group_members
        where user_id = v_member and cycle_id = v_season and status <> 'departed'
      ) then
        insert into public.group_members (group_id, cycle_id, user_id) values (v_group_id, v_season, v_member)
          on conflict do nothing;
      end if;
    end loop;
  end loop;
end
$$;

-- Tracker members with no (or no unambiguous) registered account.
select t.member_name as unregistered_member, t.group_name
from s24_tracker t
where t.member_name is not null
  and (select count(*) from public.profiles p where lower(btrim(p.full_name)) = lower(btrim(t.member_name))) <> 1
order by t.member_name;
