import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, register, reset, season, signInAs, slot, sql, switchMode } from '../fixtures';

test('a member hides a tab, finds it under More, and the choice follows them', async ({ app, browser, screen }) => {
  await reset();
  const mia = await register('Mia');

  await signInAs({ app, browser, screen }, mia);
  await expect(browser.locator('#main-nav [data-tab="boards"]')).toBeVisible();
  await expect(browser.locator('#main-nav [data-tab="overview"]')).toHaveCount(0);

  await browser.locator('#main-nav [data-tab="more"]').tap();
  await screen.getByRole('button', 'Customise tabs…').tap();
  await browser.locator('[data-nav-row="boards"] input').tap();
  const off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Save tabs').tap();
  await expect(browser.locator('#main-nav [data-tab="boards"]')).toHaveCount(0);
  await off();

  await signInAs({ app, browser, screen }, mia);
  await expect(browser.locator('#main-nav [data-tab="boards"]')).toHaveCount(0);
  await browser.locator('#main-nav [data-tab="more"]').tap();
  await screen.getByRole('button', 'Boards').tap();
  await expect(screen.getByRole('heading', 'Message Boards')).toBeVisible();

  const [prefs] = await sql<{ tabs: string[] }>("select nav_prefs->'bars'->'member'->'tabs' as tabs from profiles where id = $1", [mia.id]);
  expect(prefs.tabs).not.toContain('boards');
});

test("a club manager's Club manager bar has the Overview tab, and the mode is remembered", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });

  await signInAs({ app, browser, screen }, manager);
  await expect(browser.locator('#main-nav [data-tab="overview"]')).toHaveCount(0);
  await browser.locator('#main-nav [data-tab="group"]').tap();
  const groupScreen: string = await browser.evaluate(() => document.getElementById('group-content')!.innerText);
  expect(groupScreen).not.toContain('Club Manager Panel');
  await switchMode({ browser }, 'manager');
  await expect(browser.locator('#main-nav [data-tab="checkin"]')).toHaveCount(0);
  await browser.locator('#main-nav [data-tab="overview"]').tap();
  await expect(screen.getByRole('heading', 'Club Overview')).toBeVisible();

  await signInAs({ app, browser, screen }, manager);
  await expect(screen.getByRole('heading', 'Reminders')).toBeVisible();
  await expect(browser.locator('#main-nav [data-tab="overview"]')).toBeVisible();
});

test('a member with one role sees no switcher, and a commander sees a dot for Commander mode', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, mia, kai] = [await register('Sia'), await register('Mia'), await register('Kai')];
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', slot(2, 21, 30), [sia], { commander: true });

  await signInAs({ app, browser, screen }, kai);
  await expect(browser.locator('#mode-switcher')).toBeHidden();

  await signInAs({ app, browser, screen }, mia);
  let off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Ask to join').tap();
  await expect(screen.getByText('requested')).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, sia);
  await expect(browser.locator('#mode-switcher [data-mode="commander"] .mode-dot')).toBeVisible();
  await switchMode({ browser }, 'commander');
  await expect(screen.getByText('Mia asked to join Wed Mavericks for Season 25.', { exact: false })).toBeVisible();
});
