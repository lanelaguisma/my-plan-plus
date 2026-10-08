import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, openTab, register, reset, season, signInAs, slot, switchMode } from '../fixtures';

test('a group commander holds a place, and the newcomer lands on the roster when they register', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active');
  const groupId = await group(manager, s25, 'Wed Mavericks', slot(2, 21, 30), [sia, jessica], { commander: true });

  await signInAs({ app, browser, screen }, sia);
  await switchMode({ browser }, 'commander');
  await openTab({ browser }, 'roster');
  await screen.getByText('Hold a place for someone not yet registered').tap();
  await browser.locator(`#roster-pending-pm-name-${groupId}`).fill('Mia Chen');
  await browser.locator(`#roster-pending-pm-email-${groupId}`).fill('mia@example.test');
  await screen.getByRole('button', 'Hold a place').tap();
  await expect(screen.getByText('pending registration').first()).toBeVisible();

  await browser.evaluate(() => { localStorage.clear(); });
  await app.open('/');
  await screen.getByText('Register').tap();
  await browser.locator('#auth-name').fill('Mia Chen');
  await browser.locator('#auth-email').fill('mia@example.test');
  await browser.locator('#auth-pass').fill('password123');
  await screen.getByRole('button', 'Create Account').tap();

  await expect(screen.getByRole('heading', 'Your Group: Wed Mavericks')).toBeVisible();
});
