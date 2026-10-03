// Test harness: a fresh club database built from the migrations, in-process
// via PGlite (no Docker, no hosted project). Tests act as a specific person
// through `club.as(person)`, so the real row-level security policies apply.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname;

// The slice of Supabase the migrations rely on: the auth schema, auth.uid()
// reading the signed-in user from the request claims, and the API roles.
const SUPABASE_STUB = `
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
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
`;

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

export async function freshClub() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  for (const file of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  return {
    // Registers a person the way Supabase sign-up does; returns their identity.
    async register({ email, fullName = '' }) {
      const { rows } = await db.query(
        'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
        [email, { full_name: fullName }]
      );
      return { id: rows[0].id, email };
    },

    // Runs SQL as the given signed-in person, under row-level security.
    as(person) {
      return {
        async query(sql, params = []) {
          return db.transaction(async tx => {
            await tx.exec('set local role authenticated');
            await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [person.id]);
            const { rows } = await tx.query(sql, params);
            return rows;
          });
        },
      };
    },
  };
}
