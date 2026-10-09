import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, openTab, register, reset, rpc, season, signInAs, slot, sql } from '../fixtures';

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
