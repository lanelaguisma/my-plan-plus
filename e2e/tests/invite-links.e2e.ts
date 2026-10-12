import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { register, reset, signInAs, sql } from '../fixtures';

test('a newcomer registers through a member’s invite link and the club knows who invited them', async ({ app, browser, screen }) => {
  await reset();
  const sia = await register('Sia');
  const [{ invite_code: code }] = await sql<{ invite_code: string }>('select invite_code from profiles where id = $1', [sia.id]);

  await signInAs({ app, browser, screen }, sia);
  await expect(screen.getByRole('heading', 'Invite Someone')).toBeVisible();
  await expect(browser.locator('#invite-text')).toHaveValue(new RegExp(`\\?invite=${code}`));

  await browser.evaluate(() => { localStorage.clear(); });
  await app.open(`/?invite=${code}`);
  await expect(screen.getByText('You\'ve been invited to join the club.')).toBeVisible();
  await browser.locator('#auth-name').fill('Mia Chen');
  await browser.locator('#auth-email').fill('mia@example.test');
  await browser.locator('#auth-pass').fill('password123');
  await screen.getByRole('button', 'Create Account').tap();
  await expect(screen.getByRole('heading', 'Your Preferences')).toBeVisible();

  const [mia] = await sql<{ invited_by: string }>("select invited_by from profiles where email = 'mia@example.test'");
  expect(mia.invited_by).toBe(sia.id);
});
