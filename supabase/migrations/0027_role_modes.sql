-- ============================================================
-- 0027 — One nav bar per role (ADR 0003)
-- Each notice belongs to one role (member, commander or manager) so it
-- appears in exactly one mode. Navigation preferences hold one bar per
-- mode plus the mode last used.
-- ============================================================

-- ---------- Notice roles ----------
alter table public.notices
  add column role text not null default 'member' check (role in ('member', 'commander', 'manager'));

-- Internal: the role a notice belongs to. Club-wide matters go to Club
-- manager mode; group matters go to Commander mode when the recipient
-- commands that group, otherwise to Club manager mode for a club manager
-- (who is told when a group has no commander).
create or replace function public.notice_role(p_recipient uuid, p_kind text, p_payload jsonb)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when p_kind in ('at_risk', 'lost_commander', 'availability_mismatch', 'transfer_request',
                    'departure_recorded', 'wam_time_proposal') then 'manager'
    when p_kind in ('join_request', 'missed_wams', 'member_left', 'pending_registered',
                    'invitation_answered', 'member_moved') then
      case
        when exists (
          select 1 from public.group_seasons gs
          where gs.commander_id = p_recipient
            and gs.group_id = coalesce(
              (p_payload ->> 'group_id')::uuid,
              (select o.group_id from public.placement_offers o where o.id = (p_payload ->> 'offer_id')::uuid))
        ) then 'commander'
        when (select is_admin from public.profiles where id = p_recipient) then 'manager'
        else 'commander'
      end
    else 'member'
  end
$$;
revoke execute on function public.notice_role(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.set_notice_role()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.role := public.notice_role(new.recipient_id, new.kind, new.payload);
  return new;
end
$$;
create trigger notices_set_role
  before insert on public.notices
  for each row execute function public.set_notice_role();

update public.notices set role = public.notice_role(recipient_id, kind, payload);

-- my_notices gains the role; derived notices are all a member's.
drop function public.my_notices();
create function public.my_notices()
returns table (key text, kind text, message text, action text, payload jsonb, created_at timestamptz, read boolean, role text)
language sql stable security definer set search_path = public
as $$
  select 'n:' || n.id, n.kind, n.message, n.action, n.payload, n.created_at, n.read_at is not null, n.role
    from public.notices n where n.recipient_id = auth.uid()
  union all
  select d.key, d.kind, d.message, d.action, d.payload, d.created_at,
         exists (select 1 from public.notice_reads r where r.recipient_id = auth.uid() and r.key = d.key),
         'member'
    from public.derived_notices() d
$$;
grant execute on function public.my_notices() to authenticated;

-- ---------- Navigation preferences per mode ----------
-- { "mode": "member" | "commander" | "manager",
--   "bars": { "<mode>": { "tabs": [...], "known": [...] }, ... } }
-- Null means "my role defaults, starting in Member mode".
create or replace function public.set_nav_prefs(p_prefs jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_mode text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if p_prefs is not null then
    if p_prefs ? 'mode' and (p_prefs ->> 'mode') not in ('member', 'commander', 'manager') then
      raise exception 'Unknown mode';
    end if;
    if p_prefs ? 'bars' and jsonb_typeof(p_prefs -> 'bars') <> 'object' then
      raise exception 'Bars must be an object';
    end if;
    for v_mode in select jsonb_object_keys(coalesce(p_prefs -> 'bars', '{}'::jsonb)) loop
      if v_mode not in ('member', 'commander', 'manager') then
        raise exception 'Unknown mode';
      end if;
      if jsonb_typeof(p_prefs -> 'bars' -> v_mode -> 'tabs') is distinct from 'array' then
        raise exception 'Tabs must be a list';
      end if;
    end loop;
  end if;
  update public.profiles set nav_prefs = p_prefs where id = auth.uid();
end
$$;
