-- The slice of Supabase the migrations rely on, for local databases (unit
-- tests and the e2e stack): the API roles, the auth schema, and auth.uid(),
-- which reads the signed-in user from the request's JWT claims the way
-- Supabase does (per-claim setting or PostgREST's JSON claims).
create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'
  )::uuid
$$;
grant usage on schema auth to anon, authenticated;
