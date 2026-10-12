-- ============================================================
-- 0018 — Invite links
-- Every member has a personal invite link. Whoever registers through it
-- joins the club as an unplaced member, and the club records who invited
-- them. An unknown code is ignored, never an error.
-- ============================================================

alter table public.profiles
  add column invite_code text unique default encode(gen_random_bytes(9), 'hex'),
  add column invited_by uuid references public.profiles(id) on delete set null;
update public.profiles set invite_code = encode(gen_random_bytes(9), 'hex') where invite_code is null;
alter table public.profiles alter column invite_code set not null;

-- Placeholders: {name} (the inviter) and {link}.
alter table public.club_settings
  add column invite_message text not null default
    'Hi! I''m part of 12WC, a 12 Week Year accountability club: we each run our own 12-week plan and meet weekly in a small group to keep each other on track. I think you''d enjoy it. Register here to join the club: {link}' || chr(10) || '— {name}'
    check (char_length(invite_message) <= 1000);

-- Who invited whom is set at sign-up only; nobody edits it afterwards.
create or replace function public.guard_invite_fields()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and (new.invite_code is distinct from old.invite_code
                                 or new.invited_by is distinct from old.invited_by) then
    raise exception 'Invite details can''t be changed';
  end if;
  return new;
end
$$;
create trigger profiles_guard_invite_fields
  before update of invite_code, invited_by on public.profiles
  for each row execute function public.guard_invite_fields();

-- Sign-up: records the inviter when the new account came through an invite link.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, invited_by)
  values (
    new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''),
    (select p.id from public.profiles p
      where p.invite_code = nullif(btrim(new.raw_user_meta_data->>'invite_code'), ''))
  )
  on conflict (id) do nothing;
  return new;
end
$$;
