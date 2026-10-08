-- ============================================================
-- 0029 — Reminder: check-in missing
-- After each WAM, a member owes that week's check-in. The reminder is
-- due when the next WAM starts (overdue after that) and drops off when
-- the WAM after that starts, so a lapsed member sees at most two. A
-- cancelled WAM still counts: that week's check-in still applies.
-- Weeks before the member joined the roster, and week 13, don't count.
-- ============================================================

create or replace function public.checkin_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  with mine as (
    select w.group_id, w.cycle_id, w.week, w.starts_at, r.joined_at,
           lead(w.starts_at, 1) over win as next_starts,
           lead(w.starts_at, 2) over win as after_next_starts
    from public.my_wams() w
    join public.cycles c on c.id = w.cycle_id and c.status = 'active'
    join public.group_members r on r.group_id = w.group_id and r.cycle_id = w.cycle_id and r.user_id = auth.uid()
    window win as (partition by w.group_id, w.cycle_id order by w.week)
  )
  select 'checkin:' || m.cycle_id || ':' || m.week, 'checkin_missing', 'member',
         format('Your week %s check-in is missing.', m.week), 'view_checkin',
         jsonb_build_object('season_id', m.cycle_id, 'week', m.week),
         coalesce(m.next_starts, m.starts_at + interval '7 days'),
         now() >= coalesce(m.next_starts, m.starts_at + interval '7 days')
  from mine m
  where public.wam_ends_at(m.starts_at) <= now()
    and m.starts_at >= m.joined_at
    and now() < coalesce(m.after_next_starts, m.starts_at + interval '14 days')
    and not exists (
      select 1 from public.checkins k
      where k.user_id = auth.uid() and k.cycle_id = m.cycle_id and k.week = m.week
    )
$$;
revoke execute on function public.checkin_reminders() from public, anon, authenticated;

create or replace function public.my_reminders()
returns table (key text, kind text, role text, message text, action text, payload jsonb,
               due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = public
as $$
  select * from public.checkin_reminders()
$$;
