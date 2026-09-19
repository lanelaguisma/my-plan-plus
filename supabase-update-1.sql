-- ============================================================
-- My Plan+ Community — Update 1
-- Adds: self-service groups (create/join/leave), group + community
-- message boards, and one-group-per-cycle enforcement.
--
-- Run this ONCE in the Supabase dashboard (SQL Editor > New query)
-- on a project that already has the original supabase-schema.sql.
-- (Fresh projects should run supabase-schema.sql instead — it now
-- includes all of this.)
-- ============================================================

-- ---------- Groups: creator + suggested size ----------
alter table public.groups add column if not exists created_by uuid references public.profiles(id);
alter table public.groups add column if not exists max_size integer not null default 4;

-- ---------- Group members: tie to cycle, one group per cycle ----------
alter table public.group_members add column if not exists cycle_id uuid references public.cycles(id) on delete cascade;
update public.group_members gm
  set cycle_id = g.cycle_id
  from public.groups g
  where gm.group_id = g.id and gm.cycle_id is null;
alter table public.group_members alter column cycle_id set not null;
create unique index if not exists group_members_one_per_cycle
  on public.group_members(user_id, cycle_id);

-- ---------- Message boards ----------
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- One table for all messages: community-board posts have board_id set,
-- group-board posts have group_id set (exactly one of the two).
-- author_name is stored on the row so community posts show a name even
-- when the reader cannot see the author's profile.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references public.boards(id) on delete cascade,
  group_id uuid references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  author_name text default '',
  body text not null check (char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  check ((board_id is null) <> (group_id is null))
);
create index if not exists messages_board_idx on public.messages(board_id, created_at);
create index if not exists messages_group_idx on public.messages(group_id, created_at);

alter table public.boards enable row level security;
alter table public.messages enable row level security;

-- boards: everyone signed in can read; only admins create/rename/delete
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

-- ---------- Groups: let members create their own ----------
drop policy if exists "groups_admin_write" on public.groups;
create policy "groups_insert" on public.groups
  for insert to authenticated with check (public.is_admin() or created_by = auth.uid());
create policy "groups_update" on public.groups
  for update to authenticated
  using (public.is_admin() or created_by = auth.uid())
  with check (public.is_admin() or created_by = auth.uid());
create policy "groups_delete" on public.groups
  for delete to authenticated using (public.is_admin() or created_by = auth.uid());

-- ---------- Group members: join/leave yourself; admins place anyone ----------
drop policy if exists "group_members_admin_write" on public.group_members;
create policy "group_members_insert" on public.group_members
  for insert to authenticated with check (public.is_admin() or user_id = auth.uid());
create policy "group_members_delete" on public.group_members
  for delete to authenticated using (public.is_admin() or user_id = auth.uid());
