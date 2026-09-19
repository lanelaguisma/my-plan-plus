-- ============================================================
-- My Plan+ Community — Update 4
-- Makes admin profiles visible to all signed-in members, so the
-- app can show an "Email the Admin" contact button.
--
-- Run this ONCE in the Supabase dashboard (SQL Editor > New query),
-- after updates 1-3. Fresh projects only need supabase-schema.sql.
-- ============================================================

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (
    id = auth.uid()
    or public.is_admin()
    or is_admin  -- admins are community contacts, visible to everyone
    or id in (
      select gm2.user_id from public.group_members gm2
      where gm2.group_id in (
        select gm.group_id from public.group_members gm where gm.user_id = auth.uid()
      )
    )
  );
