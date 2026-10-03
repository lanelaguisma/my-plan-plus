import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, register, reset, season, signInAs, slot, sql } from '../fixtures';

test('a new member registers and sets their preferences', async ({ app, browser, screen }) => {
  await reset();
  await app.open('/');

  await screen.getByText('Register').tap();
  await browser.locator('#auth-name').fill('Mia Chen');
  await browser.locator('#auth-email').fill('mia@example.test');
  await browser.locator('#auth-pass').fill('password123');
  await screen.getByRole('button', 'Create Account').tap();

  await expect(screen.getByRole('heading', 'Your Preferences')).toBeVisible();
  const slotCell = browser.locator('button.slot-cell[title="Wed 2 PM"]');
  await slotCell.tap();
  await slotCell.tap(); // a second tap marks it preferred
  await browser.locator('#looking-for').fill('Other founders, a steady pace');
  const off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Save Preferences').tap();
  await expect(screen.getByRole('heading', 'Your Preferences')).toBeVisible();
  await off();

  const [mia] = await sql<{ slots: number[]; preferred: boolean; looking_for: string }>(
    "select slots, preferred_slot = (slots->>0)::int as preferred, looking_for from profiles where email = 'mia@example.test'"
  );
  expect(mia).toEqual({ slots: [mia.slots[0]], preferred: true, looking_for: 'Other founders, a steady pace' });
});

test("a member sees their group's WAMs and can say they can't make one", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', slot(2, 21, 30), [sia, jessica], { commander: true });

  await signInAs({ app, browser, screen }, jessica);

  await expect(screen.getByRole('heading', 'Your Group: Wed Mavericks')).toBeVisible();
  await expect(screen.getByRole('heading', 'WAMs this season')).toBeVisible();
  const off = await browser.onDialog(async dialog => dialog.accept('Travelling that week'));
  await screen.getByRole('button', /make it$/).first().tap();
  await expect(screen.getByRole('button', /be there$/).first()).toBeVisible();
  await off();
  const [rsvp] = await sql<{ note: string }>('select note from rsvps where member_id = $1', [jessica.id]);
  expect(rsvp.note).toBe('Travelling that week');
});

test('a member answers the week 4 pulse', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const jessica = await register('Jessica');
  const s25 = await season('Season 25', 'active', 3);
  await group(manager, s25, 'Wed Mavericks', slot(2, 21, 30), [jessica]);

  await signInAs({ app, browser, screen }, jessica);

  await expect(screen.getByRole('heading', 'Week 4 pulse')).toBeVisible();
  const off = await browser.onDialog('accept');
  await screen.getByRole('button', 'So-so').tap();
  await expect(screen.getByRole('heading', 'Week 4 pulse')).toHaveCount(0);
  await off();
  const [pulse] = await sql<{ rating: string }>('select rating from pulses where member_id = $1', [jessica.id]);
  expect(pulse.rating).toBe('so_so');
});
