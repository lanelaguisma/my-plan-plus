-- ============================================================
-- 0013 — Announcements
-- One-way messages to a chosen audience, delivered as notices, with the
-- audience and the number reached recorded. Message boards stay for
-- discussion.
-- ============================================================

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles(id) on delete set null,
  cycle_id uuid references public.cycles(id) on delete set null,
  audience text not null check (audience in ('everyone', 'groups', 'commanders', 'unplaced')),
  group_ids uuid[] not null default '{}',
  audience_label text not null,
  body text not null check (char_length(body) between 1 and 2000),
  recipient_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;

-- Sends an announcement for a season's audience. Club managers may address
-- everyone, selected groups, all group commanders or unplaced members; a
-- group commander may address only their own group.
create or replace function public.send_announcement(p_season uuid, p_audience text, p_groups uuid[], p_body text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_label text;
  v_author text;
  v_count integer := 0;
  v_recipient uuid;
begin
  if not public.is_admin() and not (
    p_audience = 'groups' and cardinality(p_groups) = 1 and public.is_commander_of(p_groups[1], p_season)
  ) then
    raise exception 'Group commanders can announce only to your own group';
  end if;
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'Write something to announce';
  end if;

  v_label := case p_audience
    when 'everyone' then 'Everyone'
    when 'commanders' then 'All group commanders'
    when 'unplaced' then 'Unplaced members'
    else 'Groups: ' || (select string_agg(name, ', ' order by name) from public.groups where id = any(p_groups))
  end;
  insert into public.announcements (author_id, cycle_id, audience, group_ids, audience_label, body)
    values (auth.uid(), p_season, p_audience, coalesce(p_groups, '{}'), v_label, btrim(p_body))
    returning id into v_id;
  select coalesce(nullif(full_name, ''), email) into v_author from public.profiles where id = auth.uid();

  for v_recipient in
    select distinct x.id from (
      select p.id from public.profiles p where p_audience = 'everyone'
      union all
      select r.user_id from public.group_members r
        where p_audience = 'groups' and r.cycle_id = p_season and r.group_id = any(p_groups) and r.status <> 'departed'
      union all
      select gs.commander_id from public.group_seasons gs
        where p_audience = 'commanders' and gs.cycle_id = p_season and gs.commander_id is not null and not gs.dormant
      union all
      select p.id from public.profiles p
        where p_audience = 'unplaced' and jsonb_array_length(p.slots) > 0
          and not exists (select 1 from public.group_members r
            where r.user_id = p.id and r.cycle_id = p_season and r.status <> 'departed')
    ) x
    where x.id <> auth.uid()
  loop
    perform public.notify(v_recipient, 'announcement',
      format('Announcement from %s: %s', v_author, btrim(p_body)), null,
      jsonb_build_object('announcement_id', v_id));
    v_count := v_count + 1;
  end loop;

  update public.announcements set recipient_count = v_count where id = v_id;
  return v_id;
end
$$;

-- What the signed-in person has announced, newest first.
create or replace function public.sent_announcements()
returns table (id uuid, audience text, recipient_count integer, body text, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select a.id, a.audience_label, a.recipient_count, a.body, a.created_at
  from public.announcements a
  where a.author_id = auth.uid() or public.is_admin()
  order by a.created_at desc
$$;
