import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, register, reset, season, signInAs, slot, sql } from '../fixtures';

const WED = slot(2, 21, 30);

test('a group commander invites a prospective member, who accepts', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica, mia] = [await register('Sia'), await register('Jessica'), await register('Mia')];
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica], { commander: true });
  await sql("update profiles set slots = $1, looking_for = 'A steady pace' where id = $2", [JSON.stringify([WED]), mia.id]);

  await signInAs({ app, browser, screen }, sia);
  await expect(screen.getByRole('heading', /Prospective Members/)).toBeVisible();
  await expect(screen.getByText('Looking for: A steady pace')).toBeVisible();
  let off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Invite').tap();
  await expect(screen.getByRole('heading', 'Invitations sent')).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, mia);
  await expect(screen.getByRole('heading', 'Invitations')).toBeVisible();
  off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Accept').tap();
  await expect(screen.getByRole('heading', 'Your Group: Wed Mavericks')).toBeVisible();
  await off();
});

test('a group commander confirms attendance for a past WAM', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica, shan] = [await register('Sia'), await register('Jessica'), await register('Shan')];
  const s25 = await season('Season 25', 'active', 3);
  const groupId = await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica, shan], { commander: true });

  await signInAs({ app, browser, screen }, sia);
  await screen.getByRole('button', 'Attendance').first().tap();
  await expect(screen.getByText(/Who attended\?/)).toBeVisible();
  await browser.locator(`input[data-att="${shan.id}"]`).tap(); // untick Shan
  await screen.getByRole('button', 'Confirm attendance').tap();
  await expect(screen.getByText('Attendance confirmed.')).toBeVisible();

  const [week1] = await sql<{ attendees: string[] }>(
    'select attendees from attendance_confirmations where group_id = $1 and week = 1', [groupId]
  );
  expect([...week1.attendees].sort()).toEqual([sia.id, jessica.id].sort());
});

test('a member asks to join a group and its commander approves', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, mia] = [await register('Sia'), await register('Mia')];
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', WED, [sia], { commander: true });

  await signInAs({ app, browser, screen }, mia);
  let off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Ask to join').tap();
  await expect(screen.getByText('requested')).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, sia);
  await expect(screen.getByRole('heading', 'Join requests')).toBeVisible();
  await screen.getByRole('button', 'Approve').tap();

  await signInAs({ app, browser, screen }, mia);
  await expect(screen.getByText('Your request to join Wed Mavericks was approved.', { exact: false })).toBeVisible();
  await expect(screen.getByRole('heading', 'Your Group: Wed Mavericks')).toBeVisible();
});

test("a group commander cancels a WAM and the rest of the roster is told", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica], { commander: true });

  await signInAs({ app, browser, screen }, sia);
  const off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Cancel').last().tap(); // week 12
  await expect(screen.getByText('cancelled', { exact: false }).first()).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, jessica);
  await expect(screen.getByText("Wed Mavericks's week 12 WAM is cancelled.", { exact: false })).toBeVisible();
});
