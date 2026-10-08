import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, openTab, register, reset, season, signInAs, slot, sql } from '../fixtures';

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
