// A local, Docker-free stand-in for Supabase, for end-to-end tests only.
//
//   browser ──► this server (one origin) ──┬─ /            index.html with CONFIG pointed here
//                                          ├─ /auth/v1/*   sign-up / sign-in (Supabase Auth subset)
//                                          ├─ /rest/v1/*   proxied to PostgREST
//                                          └─ /__e2e/*     test fixtures (reset, owner SQL)
//   PostgREST ──► PGlite over the Postgres wire protocol (pglite-socket)
//
// Everything runs from the repo's migrations, so the app under test talks to
// the same schema, functions and row-level security as production.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const ROOT = new URL('../../', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 54321);
const DB_PORT = Number(process.env.E2E_DB_PORT || 54329);
const REST_PORT = Number(process.env.E2E_REST_PORT || 54330);
const JWT_SECRET = 'e2e-local-only-secret-not-for-production-0123456789';

// ---------- Database ----------
const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync(join(ROOT, 'test/supabase-stub.sql'), 'utf8'));
await db.exec(`
  create role authenticator login noinherit;
  grant anon, authenticated to authenticator;
  create table auth.passwords (user_id uuid primary key references auth.users(id) on delete cascade, hash text not null);
`);
for (const file of readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(ROOT, 'supabase/migrations', file), 'utf8'));
}
const socket = new PGLiteSocketServer({ db, port: DB_PORT, host: '127.0.0.1', maxConnections: 4 });
await socket.start();

// ---------- PostgREST ----------
const postgrest = spawn('postgrest', [], {
  env: {
    ...process.env,
    PGRST_DB_URI: `postgres://authenticator@127.0.0.1:${DB_PORT}/postgres`,
    PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: JWT_SECRET,
    PGRST_SERVER_PORT: String(REST_PORT),
    PGRST_SERVER_HOST: '127.0.0.1',
    PGRST_DB_POOL: '1',
    PGRST_DB_CHANNEL_ENABLED: 'false',
    PGRST_DB_CONFIG: 'false',
    PGRST_DB_PREPARED_STATEMENTS: 'false',
    PGRST_LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
postgrest.on('exit', code => { console.error(`postgrest exited (${code})`); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { postgrest.kill(); socket.stop().finally(() => process.exit(0)); });
}

// ---------- Auth (the subset of Supabase Auth the app uses) ----------
const b64url = buf => Buffer.from(buf).toString('base64url');
function signJwt(claims) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const [head, body, sig] = String(token || '').split('.');
  if (!sig) return null;
  const expected = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  return claims.exp && claims.exp < Date.now() / 1000 ? null : claims;
}
const ANON_KEY = signJwt({ role: 'anon', iss: 'e2e', exp: Math.floor(Date.now() / 1000) + 30 * 86400 });

const hashPassword = pw => { const salt = randomBytes(16); return `${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPassword = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
};
const refreshTokens = new Map(); // refresh token -> user id

async function userById(id) {
  const { rows } = await db.query('select id, email, raw_user_meta_data from auth.users where id = $1', [id]);
  if (!rows.length) return null;
  const u = rows[0];
  const now = new Date().toISOString();
  return {
    id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    email_confirmed_at: now, confirmed_at: now, last_sign_in_at: now,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.raw_user_meta_data,
    identities: [], created_at: now, updated_at: now,
  };
}
async function sessionFor(id) {
  const user = await userById(id);
  const expiresIn = 3600;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const refresh = randomUUID();
  refreshTokens.set(refresh, id);
  return {
    access_token: signJwt({ sub: id, role: 'authenticated', aud: 'authenticated', email: user.email, exp: expiresAt }),
    token_type: 'bearer', expires_in: expiresIn, expires_at: expiresAt, refresh_token: refresh, user,
  };
}
const authError = (status, code, message) => ({ status, body: { code, error: code, error_code: code, msg: message, message, error_description: message } });

async function auth(req, path, url, body) {
  const bearer = verifyJwt((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (path === '/signup' && req.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || String(body.password || '').length < 6) return authError(422, 'weak_password', 'Password should be at least 6 characters.');
    const { rows: existing } = await db.query('select 1 from auth.users where lower(email) = $1', [email]);
    if (existing.length) return authError(422, 'user_already_exists', 'User already registered');
    const { rows } = await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [email, body.data || {}]);
    await db.query('insert into auth.passwords (user_id, hash) values ($1, $2)', [rows[0].id, hashPassword(body.password)]);
    return { status: 200, body: await sessionFor(rows[0].id) };
  }
  if (path === '/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const { rows } = await db.query(
        'select u.id, p.hash from auth.users u join auth.passwords p on p.user_id = u.id where lower(u.email) = $1',
        [String(body.email || '').trim().toLowerCase()]
      );
      if (!rows.length || !checkPassword(String(body.password || ''), rows[0].hash)) return authError(400, 'invalid_credentials', 'Invalid login credentials');
      return { status: 200, body: await sessionFor(rows[0].id) };
    }
    if (grant === 'refresh_token') {
      const id = refreshTokens.get(body.refresh_token);
      if (!id) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token');
      refreshTokens.delete(body.refresh_token);
      return { status: 200, body: await sessionFor(id) };
    }
  }
  if (path === '/user' && (req.method === 'GET' || req.method === 'PUT')) {
    if (!bearer || !bearer.sub) return authError(401, 'no_authorization', 'Not signed in');
    if (req.method === 'PUT' && body.password) {
      await db.query('update auth.passwords set hash = $1 where user_id = $2', [hashPassword(body.password), bearer.sub]);
    }
    return { status: 200, body: await userById(bearer.sub) };
  }
  if (path === '/logout') return { status: 204, body: null };
  if (path === '/recover') return { status: 200, body: {} };
  return authError(404, 'not_found', `Unsupported auth route ${req.method} ${path}`);
}

// ---------- Test fixtures ----------
// Wipes every row (keeping the schema and club settings) between tests.
async function reset() {
  const { rows } = await db.query(`
    select string_agg(format('%I.%I', schemaname, tablename), ', ') as tables
    from pg_tables where schemaname = 'public' and tablename <> 'club_settings'`);
  await db.exec(`truncate auth.users, ${rows[0].tables} restart identity cascade;`);
  refreshTokens.clear();
}

// ---------- HTTP ----------
const page = readFileSync(join(ROOT, 'index.html'), 'utf8')
  .replace(/SUPABASE_URL:\s*'[^']*'/, 'SUPABASE_URL: location.origin')
  .replace(/SUPABASE_ANON_KEY:\s*'[^']*'/, `SUPABASE_ANON_KEY: '${ANON_KEY}'`);
if (!page.includes(ANON_KEY)) throw new Error('Could not point index.html at the e2e stack');

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body == null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, page, 'text/html; charset=utf-8');
    if (url.pathname === '/MyPlan+.png') return send(res, 200, readFileSync(join(ROOT, 'MyPlan+.png')), 'image/png');
    if (url.pathname === '/__e2e/health') return send(res, 200, { ok: true });

    if (url.pathname.startsWith('/auth/v1/')) {
      const raw = await readBody(req);
      const { status, body } = await auth(req, url.pathname.slice('/auth/v1'.length), url, raw.length ? JSON.parse(raw) : {});
      return send(res, status, body);
    }

    if (url.pathname === '/__e2e/reset' && req.method === 'POST') { await reset(); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__e2e/sql' && req.method === 'POST') {
      const { sql, params = [] } = JSON.parse(await readBody(req));
      const { rows } = await db.query(sql, params);
      return send(res, 200, rows);
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const raw = await readBody(req);
      const headers = { ...req.headers, host: `127.0.0.1:${REST_PORT}` };
      // Requests without a signed-in user carry the anon key as their bearer.
      if (!verifyJwt((headers.authorization || '').replace(/^Bearer /, ''))) headers.authorization = `Bearer ${ANON_KEY}`;
      delete headers['content-length'];
      const upstream = http.request({
        host: '127.0.0.1', port: REST_PORT, method: req.method,
        path: url.pathname.slice('/rest/v1'.length) + url.search, headers: { ...headers, 'content-length': raw.length },
      }, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
      upstream.on('error', err => send(res, 502, { message: String(err) }));
      upstream.end(raw);
      return;
    }
    send(res, 404, { message: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { message: String(err && err.message || err) });
  }
});

// Ready once PostgREST answers.
for (let i = 0; i < 100; i++) {
  const ok = await new Promise(r => http.get({ host: '127.0.0.1', port: REST_PORT, path: '/' }, x => { x.resume(); r(x.statusCode < 500); }).on('error', () => r(false)));
  if (ok) break;
  await new Promise(r => setTimeout(r, 200));
}
server.listen(PORT, '127.0.0.1', () => console.log(`e2e stack ready on http://127.0.0.1:${PORT}`));
