import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { group, openTab, register, reset, season, signInAs, slot, sql, switchMode } from '../fixtures';

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
  await openTab({ browser }, 'reminders');
  await expect(screen.getByText('Your request to join Wed Mavericks was approved.', { exact: false })).toBeVisible();
  await openTab({ browser }, 'group');
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
  await openTab({ browser }, 'reminders');
  await expect(screen.getByText("Wed Mavericks's week 12 WAM is cancelled.", { exact: false })).toBeVisible();
});

test('a member already in a group applies to another and moves when approved', async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica, kiran] = [await register('Sia'), await register('Jessica'), await register('Kiran')];
  const s25 = await season('Season 25', 'active');
  await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica], { commander: true });
  await group(manager, s25, 'Fri-B', slot(4, 23), [kiran], { commander: true });

  await signInAs({ app, browser, screen }, jessica);
  await screen.getByText('Apply to another group').tap();
  const off = await browser.onDialog('accept');
  await screen.getByRole('button', 'Ask to join').tap();
  await expect(screen.getByText('requested')).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, kiran);
  await expect(screen.getByText('currently in Wed Mavericks')).toBeVisible();
  await screen.getByRole('button', 'Approve').tap();

  await signInAs({ app, browser, screen }, jessica);
  await expect(screen.getByRole('heading', 'Your Group: Fri-B')).toBeVisible();
});

test("a group commander checks the roster dashboard and opens a member's goals", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active', 3);
  await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica], { commander: true });
  await sql("insert into plan_data (user_id, key, data) values ($1, 'myplanplus_goals', $2)",
    [jessica.id, JSON.stringify([{ id: 'g1', title: 'Run a half marathon', order: 0 }])]);
  await sql('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 1, 72), ($1, $2, 2, 88)', [jessica.id, s25]);

  await signInAs({ app, browser, screen }, sia);
  await switchMode({ browser }, 'commander');
  await openTab({ browser }, 'roster');
  await expect(screen.getByRole('heading', 'Group Roster')).toBeVisible();
  await expect(screen.getByText('88%')).toBeVisible();
  await screen.getByRole('link', 'Jessica').tap();
  await expect(screen.getByText('Run a half marathon', { exact: false })).toBeVisible();
});

test("a group commander logs a member's check-in and the member sees who logged it", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active', 3);
  await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica], { commander: true });

  await signInAs({ app, browser, screen }, sia);
  await switchMode({ browser }, 'commander');
  await openTab({ browser }, 'roster');
  await screen.getByRole('link', 'Jessica').tap();
  const answers = ['3', '80', 'given at the WAM'];
  const off = await browser.onDialog(dialog => dialog.message.startsWith('Logged') ? dialog.accept() : dialog.accept(answers.shift()));
  await screen.getByRole('button', 'Log check-in').tap();
  await expect(screen.getByText('80%').first()).toBeVisible();
  await off();

  await signInAs({ app, browser, screen }, jessica);
  await openTab({ browser }, 'reminders');
  await expect(screen.getByText('Sia logged a 80% check-in for week 3 for you', { exact: false })).toBeVisible();
  const [row] = await sql<{ score: number; entered_by: string }>(
    'select score, entered_by from checkins where user_id = $1 and week = 3', [jessica.id]);
  expect(row).toEqual({ score: 80, entered_by: sia.id });
});

test("a group commander raises their group's minimum size", async ({ app, browser, screen }) => {
  await reset();
  const manager = await register('Iain Dunn', { clubManager: true });
  const [sia, jessica] = [await register('Sia'), await register('Jessica')];
  const s25 = await season('Season 25', 'active');
  const groupId = await group(manager, s25, 'Wed Mavericks', WED, [sia, jessica], { commander: true });

  await signInAs({ app, browser, screen }, sia);
  await switchMode({ browser }, 'commander');
  await openTab({ browser }, 'roster');
  await expect(screen.getByText(/min 2/)).toBeVisible();
  const off = await browser.onDialog(async dialog => dialog.accept('3'));
  await screen.getByText('change', { exact: true }).tap();
  await expect(screen.getByText(/min 3/)).toBeVisible();
  await off();

  const [g] = await sql<{ min_size_override: number }>('select min_size_override from groups where id = $1', [groupId]);
  expect(g.min_size_override).toBe(3);
});
