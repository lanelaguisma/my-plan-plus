// Helpers that prepare data through the e2e stack's test-only endpoints, so
// each test starts from a known club and drives only the flow it is about.
export const STACK = 'http://127.0.0.1:54321';
export const PASSWORD = 'password123';

export async function reset(): Promise<void> {
  const res = await fetch(`${STACK}/__e2e/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`reset failed: ${res.status}`);
}

// Runs SQL as the database owner (bypassing row-level security).
export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const res = await fetch(`${STACK}/__e2e/sql`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: query, params }),
  });
  if (!res.ok) throw new Error(`sql failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<T[]>;
}

export interface Person { id: string; email: string; name: string }

// Registers someone the way the app's sign-up does.
export async function register(name: string, { clubManager = false } = {}): Promise<Person> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@example.test`;
  const res = await fetch(`${STACK}/auth/v1/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, data: { full_name: name } }),
  });
  if (!res.ok) throw new Error(`register ${name} failed: ${await res.text()}`);
  const { user } = await res.json();
  if (clubManager) await sql('update profiles set is_admin = true where id = $1', [user.id]);
  return { id: user.id, email, name };
}

// Calls a database function as a signed-in person, through PostgREST.
export async function rpc(person: Person, fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const token = await signIn(person);
  const res = await fetch(`${STACK}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} failed: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function signIn(person: Person): Promise<string> {
  const res = await fetch(`${STACK}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: person.email, password: PASSWORD }),
  });
  return (await res.json()).access_token;
}

// A season starting `weeksAgo` Mondays ago (0 = this week) with a status.
export async function season(name: string, status: string, weeksAgo = 0): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `insert into cycles (name, start_date, status, activated_at)
     values ($1, (date_trunc('week', now()) - make_interval(weeks => $2))::date, $3,
             case when $3 = 'active' then date_trunc('week', now()) - make_interval(weeks => $2) end)
     returning id`,
    [name, weeksAgo, status]
  );
  return row.id;
}

// The minute-of-week (UTC) for a weekday (0 = Monday) and UTC hour.
export const slot = (day: number, hourUtc: number, minute = 0) => day * 1440 + hourUtc * 60 + minute;

// Signs in through the app's own sign-in form (signing out anyone first).
export async function signInAs(
  { app, browser, screen }: { app: any; browser: any; screen: any },
  person: Person
): Promise<void> {
  await app.open('/');
  await browser.evaluate(() => { localStorage.clear(); });
  await app.open('/');
  await browser.locator('#auth-email').fill(person.email);
  await browser.locator('#auth-pass').fill(PASSWORD);
  await screen.getByRole('button', 'Sign In').tap();
  await browser.locator('#main-nav').waitFor?.({ state: 'visible' });
}

// A group running in a season with the given roster; the first person on the
// roster commands it when `commander` is true.
export async function group(
  manager: Person, seasonId: string, name: string, slotMow: number, roster: Person[], { commander = false } = {}
): Promise<string> {
  const id = await rpc(manager, 'create_season_group', {
    p_season: seasonId, p_name: name, p_slot: slotMow, p_members: roster.map(p => p.id),
  }) as string;
  if (commander) await rpc(manager, 'appoint_group_commander', { p_group: id, p_season: seasonId, p_member: roster[0].id });
  return id;
}

// Switches the app to one of the signed-in person's modes (ADR 0003).
export async function switchMode({ browser }: { browser: any }, mode: 'member' | 'commander' | 'manager'): Promise<void> {
  await browser.locator(`#mode-switcher [data-mode="${mode}"]`).tap();
}

// Opens a tab on the current bar.
export async function openTab({ browser }: { browser: any }, tab: string): Promise<void> {
  await browser.locator(`#main-nav [data-tab="${tab}"]`).tap();
}
