-- ============================================================
-- 0017 — Navigation preferences
-- Each person chooses which tabs show in their navigation bar and in what
-- order. The choice is theirs alone: not even a club manager can change it.
-- Tabs are cosmetic; every permission is still enforced here.
-- ============================================================

-- { "tabs": [visible tab ids, in order], "known": [every tab id offered when saved] }
-- Null means "use my role's defaults".
alter table public.profiles add column nav_prefs jsonb;

create or replace function public.guard_nav_prefs()
returns trigger
language plpgsql
as $$
begin
  if new.nav_prefs is distinct from old.nav_prefs
     and auth.uid() is not null and auth.uid() is distinct from new.id then
    raise exception 'Only you can change your own tabs';
  end if;
  return new;
end
$$;
create trigger profiles_guard_nav_prefs
  before update of nav_prefs on public.profiles
  for each row execute function public.guard_nav_prefs();

-- Saves (or, with null, resets to the role defaults) the signed-in person's tabs.
create or replace function public.set_nav_prefs(p_prefs jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if p_prefs is not null and jsonb_typeof(p_prefs -> 'tabs') is distinct from 'array' then
    raise exception 'Tabs must be a list';
  end if;
  update public.profiles set nav_prefs = p_prefs where id = auth.uid();
end
$$;
