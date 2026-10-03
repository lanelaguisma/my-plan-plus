import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, register, reset, rpc, season, signInAs, slot, sql } from '../fixtures';

const WED = slot(2, 21, 30);

test('a club manager places an unplaced member from a suggestion, and the member is told', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, mia] = [await register('Sia'), await register('Mia')];
  const s25 = await season('Season 25', 'enrolling');
  await group(manager, s25, 'Wed Mavericks', WED, [sia], { commander: true });
  await sql("update profiles set slots = $1, preferred_slot = $2, looking_for = 'Founders' where id = $3", [JSON.stringify([WED]), WED, mia.id]);

  await signInAs({ app, browser, screen }, manager);
  await screen.getByRole('button', 'Open Club Manager Panel').tap();
  await expect(screen.getByRole('heading', /Unplaced Members/)).toBeVisible();
  await expect(screen.getByText(/★ preferred · 3 of 4 places open/)).toBeVisible();
  await screen.getByRole('button', 'Assign').tap();
  await expect(screen.getByText('Everyone with availability is on a roster.')).toBeVisible();

  await signInAs({ app, browser, screen }, mia);
  await expect(screen.getByText("You've been assigned to Wed Mavericks for Season 25.", { exact: false })).toBeVisible();
});

test('opening enrolment asks each member to confirm they are continuing', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const cameron = await register('Cameron');
  const s24 = await season('Season 24', 'active', 6);
  await group(manager, s24, 'Fri-B', slot(4, 23), [cameron]);
  await sql("insert into cycles (name, start_date, status) values ('Season 25', (date_trunc('week', now()) + interval '7 weeks')::date, 'setup')");

  await signInAs({ app, browser, screen }, manager);
  await screen.getByRole('button', 'Open Club Manager Panel').tap();
  const off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Open sign-up').tap();
  await expect(screen.getByRole('heading', /Continuation/)).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, cameron);
  await expect(screen.getByText('Are you continuing with Fri-B for Season 25?')).toBeVisible();
  await screen.getByRole('button', /^Yes, I.m continuing$/).tap();
  await expect(screen.getByText('Are you continuing with Fri-B for Season 25?')).toHaveCount(0);
  const [entry] = await sql<{ status: string }>(
    "select r.status from group_members r join cycles c on c.id = r.cycle_id where c.name = 'Season 25' and r.user_id = $1", [cameron.id]
  );
  expect(entry.status).toBe('on_roster');
});

test('the club overview shows an at-risk group and why', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active', 3);
  await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica]);

  await signInAs({ app, browser, screen }, manager);
  await screen.getByRole('button', 'Open Club Manager Panel').tap();

  await expect(screen.getByRole('heading', /Club Overview/)).toBeVisible();
  await expect(screen.getByText('No group commander.', { exact: false })).toBeVisible();
  await expect(screen.getByText('2 members — below the minimum of 3.', { exact: false })).toBeVisible();
});

test('a club manager announces to a group and its members receive it', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const jessica = await register('Jessica');
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', WED, [jessica]);

  await signInAs({ app, browser, screen }, manager);
  await screen.getByRole('button', 'Open Club Manager Panel').tap();
  await browser.locator('#ann-body').fill('WAMs pause over the holidays.');
  await screen.getByRole('button', 'Send announcement').tap();
  await expect(screen.getByText(/Everyone · reached 1/)).toBeVisible();

  await signInAs({ app, browser, screen }, jessica);
  await expect(screen.getByText('Announcement from Iain Dunn: WAMs pause over the holidays.', { exact: false })).toBeVisible();
});

test('a member asks to transfer and a club manager moves them', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [jessica, kiran] = [await register('Jessica'), await register('Kiran')];
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', WED, [jessica]);
  await group(manager, s25, 'Fri-B', slot(4, 23), [kiran]);

  await signInAs({ app, browser, screen }, jessica);
  // A prompt for the reason, then a confirmation alert: accepting both is fine.
  const off = await browser.onDialog(async dialog => dialog.accept('Fridays suit me better now'));
  await screen.getByRole('button', 'Request a transfer').tap();
  await expect(screen.getByRole('button', 'Cancel transfer request')).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, manager);
  await screen.getByRole('button', 'Open Club Manager Panel').tap();
  await expect(screen.getByText('Fridays suit me better now', { exact: false, visible: true })).toBeVisible();
  await screen.getByRole('button', 'Move').tap();

  await signInAs({ app, browser, screen }, jessica);
  await expect(screen.getByRole('heading', 'Your Group: Fri-B')).toBeVisible();
});

test('a club manager creates the next season from the suggested start date', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  await sql("insert into cycles (name, start_date, status) values ('Season 24', '2026-10-05', 'active')");

  await signInAs({ app, browser, screen }, manager);
  await screen.getByRole('button', 'Open Club Manager Panel').tap();
  await expect(browser.locator('#new-cycle-start')).toHaveValue('2027-01-04');
  await browser.locator('#new-cycle-name').fill('Season 25');
  await screen.getByRole('button', '+ Create Season').tap();

  await expect(screen.getByText('Season 25', { exact: false }).first()).toBeVisible();
  const [s25] = await sql<{ start: string }>("select to_char(start_date, 'YYYY-MM-DD') as start from cycles where name = 'Season 25'");
  expect(s25.start).toBe('2027-01-04');
});
