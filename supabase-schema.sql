-- ============================================================
-- My Plan+ Community — Supabase database schema
-- Run this once in the Supabase dashboard: SQL Editor > New query
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Tables ----------

-- One row per registered person (created automatically on signup)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text default '',
  timezone text default '',
  -- Nominated weekly session times: JSON array of "minute of the week"
  -- integers counted from Monday 00:00 UTC (sessions are 45 minutes)
  slots jsonb not null default '[]'::jsonb,
  -- One nominated time may be marked as preferred; allocation favours it
  preferred_slot integer,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- A 12-week year. Lifecycle: setup -> enrolling (open for sign-up,
-- may overlap the running cycle) -> active (running) -> archived.
-- Only one cycle should be 'active' and one 'enrolling' at a time.
create table public.cycles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_date date not null,
  status text not null default 'setup' check (status in ('setup','enrolling','active','archived')),
  created_at timestamptz not null default now()
);

-- Accountability groups within a cycle, each with a weekly meeting slot.
-- Members can create their own groups; admins can create them too.
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  name text not null,
  slot_mow integer not null, -- meeting start, minutes from Monday 00:00 UTC
  wam_link text default '',
  created_by uuid references public.profiles(id),
  max_size integer not null default 4, -- typical size; admin can place more
  created_at timestamptz not null default now()
);
create index groups_cycle_idx on public.groups(cycle_id);

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members(user_id);
create unique index group_members_one_per_cycle on public.group_members(user_id, cycle_id);

-- Community-wide message boards (created by admins)
create table public.boards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- One table for all messages: community-board posts have board_id set,
-- group-board posts have group_id set (exactly one of the two).
-- author_name is stored on the row so community posts show a name even
-- when the reader cannot see the author's profile.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references public.boards(id) on delete cascade,
  group_id uuid references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  author_name text default '',
  body text not null check (char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  check ((board_id is null) <> (group_id is null))
);
create index messages_board_idx on public.messages(board_id, created_at);
create index messages_group_idx on public.messages(group_id, created_at);

-- Shared weekly check-ins for team accountability: one row per member
-- per week, written automatically when a check-in is saved. Full detail
-- (score + reflections) is visible within the member's group; scores
-- alone are exposed community-wide through the checkin_scores view.
create table public.checkins (
  user_id uuid not null references public.profiles(id) on delete cascade,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  week integer not null check (week between 1 and 13),
  score integer not null default 0 check (score between 0 and 100),
  author_name text default '',
  reflections jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, cycle_id, week)
);
create index checkins_cycle_idx on public.checkins(cycle_id, week);

-- Each member's My Plan+ data (goals, tactics, weekly check-ins, settings),
-- one row per storage key — private to that member.
create table public.plan_data (
  user_id uuid not null references public.profiles(id) on delete cascade,
  key text not null,
  data jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------- Automatic profile creation on signup ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Row-level security ----------

-- Admin check that is safe to call from within profiles policies
create or replace function public.is_admin()
returns boolean
language sql security definer set search_path = public stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

alter table public.profiles enable row level security;
alter table public.cycles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.plan_data enable row level security;
alter table public.boards enable row level security;
alter table public.messages enable row level security;
alter table public.checkins enable row level security;

-- profiles: you can see yourself, your own group-mates, and the admins
-- (community contacts); admins see everyone
create policy "profiles_select" on public.profiles
  for select to authenticated using (
    id = auth.uid()
    or public.is_admin()
    or is_admin
    or id in (
      select gm2.user_id from public.group_members gm2
      where gm2.group_id in (
        select gm.group_id from public.group_members gm where gm.user_id = auth.uid()
      )
    )
  );
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (id = auth.uid());
create policy "profiles_update" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- cycles: everyone signed in can read; only admins can change
create policy "cycles_select" on public.cycles
  for select to authenticated using (true);
create policy "cycles_admin_write" on public.cycles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- groups: everyone signed in can read; members create their own groups;
-- creators and admins can change/delete them
create policy "groups_select" on public.groups
  for select to authenticated using (true);
create policy "groups_insert" on public.groups
  for insert to authenticated with check (public.is_admin() or created_by = auth.uid());
create policy "groups_update" on public.groups
  for update to authenticated
  using (public.is_admin() or created_by = auth.uid())
  with check (public.is_admin() or created_by = auth.uid());
create policy "groups_delete" on public.groups
  for delete to authenticated using (public.is_admin() or created_by = auth.uid());

-- group membership: readable by all signed-in users (needed to show groups);
-- people join/leave themselves, admins can place or remove anyone
create policy "group_members_select" on public.group_members
  for select to authenticated using (true);
create policy "group_members_insert" on public.group_members
  for insert to authenticated with check (public.is_admin() or user_id = auth.uid());
create policy "group_members_delete" on public.group_members
  for delete to authenticated using (public.is_admin() or user_id = auth.uid());

-- boards: everyone signed in can read; only admins create/delete
create policy "boards_select" on public.boards
  for select to authenticated using (true);
create policy "boards_admin_write" on public.boards
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- messages: community boards are open to all signed-in users;
-- group boards only to that group's members (and admins)
create policy "messages_select" on public.messages
  for select to authenticated using (
    board_id is not null
    or public.is_admin()
    or group_id in (select gm.group_id from public.group_members gm where gm.user_id = auth.uid())
  );
create policy "messages_insert" on public.messages
  for insert to authenticated with check (
    user_id = auth.uid() and (
      board_id is not null
      or public.is_admin()
      or group_id in (select gm.group_id from public.group_members gm where gm.user_id = auth.uid())
    )
  );
create policy "messages_delete" on public.messages
  for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- check-ins: full detail for yourself, your group-mates and admins;
-- each member writes only their own rows
create policy "checkins_select" on public.checkins
  for select to authenticated using (
    user_id = auth.uid()
    or public.is_admin()
    or user_id in (
      select gm2.user_id from public.group_members gm2
      where gm2.group_id in (
        select gm.group_id from public.group_members gm where gm.user_id = auth.uid()
      )
    )
  );
create policy "checkins_insert_own" on public.checkins
  for insert to authenticated with check (user_id = auth.uid());
create policy "checkins_update_own" on public.checkins
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "checkins_delete" on public.checkins
  for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- Scores-only view for the cross-group scoreboard (runs with owner
-- rights, deliberately bypassing the row policy; exposes no reflections)
create or replace view public.checkin_scores as
  select user_id, cycle_id, week, score, updated_at from public.checkins;
revoke all on public.checkin_scores from anon;
grant select on public.checkin_scores to authenticated;

-- plan data: strictly private — each member reads and writes only their own
create policy "plan_data_own" on public.plan_data
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- AFTER you have registered yourself in the app, make your
-- account the admin by running (replace the email):
--
--   update public.profiles set is_admin = true
--   where email = 'you@example.com';
-- ============================================================
