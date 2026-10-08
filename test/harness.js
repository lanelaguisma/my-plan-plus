// Test harness: a fresh club database built from the migrations, in-process
// via PGlite (no Docker, no hosted project). Tests act as a specific person
// through `club.as(person)`, so the real row-level security policies apply.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname;

// The slice of Supabase the migrations rely on (shared with the e2e stack).
const SUPABASE_STUB = readFileSync(new URL('./supabase-stub.sql', import.meta.url), 'utf8');

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

// Building the schema is the slow part, so the global setup builds the fully
// migrated database once per run (CLUB_DB_SNAPSHOT) and every test starts
// from a copy of it; without that file, each worker builds its own.
let migratedSnapshot = process.env.CLUB_DB_SNAPSHOT
  ? new Blob([readFileSync(process.env.CLUB_DB_SNAPSHOT)])
  : null;

export async function buildMigratedSnapshot() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  for (const file of migrationFiles()) await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  const snapshot = await db.dumpDataDir('none');
  await db.close();
  return snapshot;
}

// `upTo` stops after the named migration (e.g. '0001') so a test can seed
// data in an older shape, then call `club.migrate()` to apply the rest.
export async function freshClub({ upTo } = {}) {
  const pending = migrationFiles();
  let db;
  if (!upTo && migratedSnapshot) {
    db = await PGlite.create({ extensions: { pgcrypto }, loadDataDir: migratedSnapshot });
    pending.length = 0;
  } else {
    db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(SUPABASE_STUB);
  }
  async function applyThrough(stop) {
    while (pending.length) {
      const file = pending.shift();
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      if (stop && file.startsWith(stop)) return;
    }
  }
  await applyThrough(upTo);
  if (!upTo && !migratedSnapshot) migratedSnapshot = await db.dumpDataDir('none');

  return {
    // Applies every migration not yet applied.
    async migrate() {
      await applyThrough();
    },

    // Runs SQL as the database owner, bypassing row-level security (fixtures only).
    async owner(sql, params = []) {
      const { rows } = await db.query(sql, params);
      return rows;
    },

    // Registers a person the way Supabase sign-up does; returns their identity.
    async register({ email, fullName = '' }) {
      const { rows } = await db.query(
        'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
        [email, { full_name: fullName }]
      );
      return { id: rows[0].id, email };
    },

    // Runs a multi-statement SQL script as the database owner; returns the
    // rows of its last statement (how seed scripts report back).
    async ownerScript(sql) {
      const results = await db.exec(sql);
      return results.length ? results[results.length - 1].rows : [];
    },

    // Makes a registered person a club manager (done by hand in SQL in production).
    async makeClubManager(person) {
      await db.query('update public.profiles set is_admin = true where id = $1', [person.id]);
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
