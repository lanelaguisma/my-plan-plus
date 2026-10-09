import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, openTab, register, reset, rpc, season, signInAs, slot, sql, switchMode } from '../fixtures';

const MON_0005 = slot(0, 0, 5); // Mondays 00:05 UTC: this week's WAM has already happened

test("a member is reminded of a missing check-in and goes straight to it", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active', 1);
  await group(manager, s25, 'Wed Mavericks', MON_0005, [sia, jessica], { commander: true });
  await sql("update group_members set joined_at = now() - interval '30 days'");

  await signInAs({ app, browser, screen }, jessica);
  await expect(browser.locator('#main-nav [data-tab="reminders"] .nav-badge')).toBeVisible();
  await openTab({ browser }, 'reminders');
  await expect(screen.getByText('Your week 1 check-in is missing.', { exact: false })).toBeVisible();
  await expect(screen.getByText(/Overdue/).first()).toBeVisible();
  await expect(screen.getByText('Your week 2 check-in is missing.', { exact: false })).toBeVisible();

  await browser.locator('[data-reminder="checkin_missing"] button').first().tap();
  await expect(screen.getByRole('heading', /Check-in/)).toBeVisible();
});

test('a member is reminded to confirm continuation, with the days left, until they answer', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const cameron = await register('Cameron');
  const s24 = await season('Season 24', 'active', 6);
  await group(manager, s24, 'Fri-B', slot(4, 23), [cameron]);
  const [s25] = await sql<{ id: string }>(
    "insert into cycles (name, start_date, status) values ('Season 25', (date_trunc('week', now()) + interval '7 weeks')::date, 'setup') returning id");
  await rpc(manager, 'open_enrolment', { p_season: s25.id });

  await signInAs({ app, browser, screen }, cameron);
  await openTab({ browser }, 'reminders');
  await expect(screen.getByText(/Are you continuing with Fri-B for Season 25\? \d+ days left to confirm\./)).toBeVisible();
  await browser.locator('[data-reminder="continuation"] button').tap();
  await screen.getByRole('button', /^Yes, I.m continuing$/).tap();
  await expect(screen.getByText(/You're in Fri-B/)).toBeVisible();

  await openTab({ browser }, 'reminders');
  await expect(browser.locator('[data-reminder="continuation"]')).toHaveCount(0);
});

test("a group commander is told who can't make tomorrow's WAM", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active', 2);
  const groupId = await group(manager, s25, 'Wed Mavericks', MON_0005, [sia, jessica], { commander: true });
  await sql(`update groups set slot_mow = (extract(epoch from (now() + interval '12 hours')
      - (date_trunc('week', now() at time zone 'UTC') at time zone 'UTC')) / 60)::int % 10080 where id = $1`, [groupId]);
  const [{ week }] = await sql<{ week: number }>(
    "select week from season_wams($1, $2) where starts_at > now() and starts_at <= now() + interval '24 hours'", [groupId, s25]);
  await rpc(jessica, 'set_rsvp', { p_group: groupId, p_season: s25, p_week: week, p_attending: false, p_note: 'Away' });

  await signInAs({ app, browser, screen }, sia);
  await expect(browser.locator('#mode-switcher [data-mode="commander"] .mode-dot')).toBeVisible();
  await switchMode({ browser }, 'commander');
  await expect(screen.getByText("Jessica can't make it", { exact: false })).toBeVisible();
  await screen.getByRole('button', 'Prepare').tap();
  await expect(screen.getByRole('heading', 'Group Roster')).toBeVisible();
});

test('a group commander is reminded to confirm attendance and does it from the reminder', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active', 0);
  await group(manager, s25, 'Wed Mavericks', MON_0005, [sia, jessica], { commander: true });

  await signInAs({ app, browser, screen }, sia);
  await switchMode({ browser }, 'commander');
  await expect(screen.getByText("Confirm who attended Wed Mavericks's week 1 WAM.", { exact: false })).toBeVisible();
  await screen.getByRole('button', 'Confirm').tap();
  await expect(screen.getByText(/Who attended\?/)).toBeVisible();
  await screen.getByRole('button', 'Confirm attendance').tap();
  await expect(screen.getByText('Attendance confirmed.')).toBeVisible();

  await openTab({ browser }, 'reminders');
  await expect(browser.locator('[data-reminder="attendance_unconfirmed"]')).toHaveCount(0);
});

test('a club manager is reminded about unplaced members and goes to place them', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const mia = await register('Mia');
  await season('Season 25', 'active');
  await sql("update profiles set slots = $1 where id = $2", [JSON.stringify([slot(2, 21, 30)]), mia.id]);

  await signInAs({ app, browser, screen }, manager);
  await expect(browser.locator('#mode-switcher [data-mode="manager"] .mode-dot')).toBeVisible();
  await switchMode({ browser }, 'manager');
  await expect(screen.getByText('1 unplaced member for Season 25 — place them in a group.', { exact: false })).toBeVisible();
  await screen.getByRole('button', 'Place').tap();
  await expect(screen.getByRole('heading', /Unplaced Members/)).toBeVisible();
});
