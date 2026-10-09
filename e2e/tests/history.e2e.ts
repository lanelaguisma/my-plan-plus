import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, openTab, register, reset, season, signInAs, slot, sql, switchMode } from '../fixtures';

const WED = slot(2, 21, 30);

// Wed Mavericks ran in Season 24 (archived) and runs again in Season 25,
// with Sia commanding both.
async function twoSeasons() {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s24 = await season('Season 24', 'archived', 16);
  const s25 = await season('Season 25', 'active', 3);
  const g = await group(manager, s24, 'Wed Mavericks', WED, [sia, jessica], { commander: true });
  await sql('insert into group_seasons (group_id, cycle_id, commander_id) values ($1, $2, $3)', [g, s25, sia.id]);
  await sql("insert into group_members (group_id, user_id, cycle_id, status) values ($1, $2, $4, 'on_roster'), ($1, $3, $4, 'on_roster')",
    [g, sia.id, jessica.id, s25]);
  await sql('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 1, 90)', [jessica.id, s24]);
  return { manager, sia, jessica };
}

test('a member sees their seasons in Reports, at phone width', async ({ app, browser, screen }) => {
  const { jessica } = await twoSeasons();
  await browser.setViewport({ width: 375, height: 760 });

  await signInAs({ app, browser, screen }, jessica);
  await openTab({ browser }, 'more');
  await screen.getByRole('button', 'Reports').tap();
  await expect(screen.getByRole('heading', 'Season History')).toBeVisible();
  await expect(screen.getByText('1/12')).toBeVisible();
  const overflow: number = await browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a group commander sees their group's seasons", async ({ app, browser, screen }) => {
  const { sia } = await twoSeasons();

  await signInAs({ app, browser, screen }, sia);
  await switchMode({ browser }, 'commander');
  await openTab({ browser }, 'history');
  await expect(screen.getByRole('heading', 'Wed Mavericks · by season')).toBeVisible();
  await expect(screen.getByText('Season 24')).toBeVisible();
});

test('a club manager compares groups by season and opens one', async ({ app, browser, screen }) => {
  const { manager } = await twoSeasons();

  await signInAs({ app, browser, screen }, manager);
  await switchMode({ browser }, 'manager');
  await openTab({ browser }, 'clubhistory');
  await expect(screen.getByRole('heading', 'Club History')).toBeVisible();
  await browser.locator('#history-metric').selectOption({ value: 'roster_size' });
  await screen.getByRole('link', '2').first().tap();
  await expect(screen.getByRole('heading', 'Groups', { exact: true })).toBeVisible();
});
