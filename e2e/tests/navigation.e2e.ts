import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { register, reset, signInAs, sql } from '../fixtures';

test('a member hides a tab, finds it under More, and the choice follows them', async ({ app, browser, screen }) => {
  await reset();
  const mia = await register('Mia');

  await signInAs({ app, browser, screen }, mia);
  await expect(browser.locator('#main-nav [data-tab="boards"]')).toBeVisible();
  await expect(browser.locator('#main-nav [data-tab="admin"]')).toHaveCount(0);

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

  const [prefs] = await sql<{ tabs: string[] }>("select nav_prefs->'tabs' as tabs from profiles where id = $1", [mia.id]);
  expect(prefs.tabs).not.toContain('boards');
});

test("a club manager's bar starts with the Manage tab", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });

  await signInAs({ app, browser, screen }, manager);
  await browser.locator('#main-nav [data-tab="admin"]').tap();

  await expect(screen.getByRole('heading', 'Club Manager')).toBeVisible();
});
