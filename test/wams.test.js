import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

const iso = rows => rows.map(r => ({ ...r, starts_at: new Date(r.starts_at).toISOString() }));

async function commandedGroup() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.as(manager).query("update groups set wam_link = 'https://zoom.us/j/wed' where id = $1", [groupId]);
  return { ...fixture, sia };
}

async function wams(club, viewer, groupId, seasonId) {
  return iso(await club.as(viewer).query(
    'select week, starts_at, link, cancelled from season_wams($1, $2) order by week', [groupId, seasonId]
  ));
}

describe('the WAM schedule', () => {
  test("a group has twelve WAMs a season, at its weekly time from the season's start", async () => {
    const { club, s25, groupId, outsider } = await commandedGroup();

    const schedule = await wams(club, outsider, groupId, s25.id);

    expect([schedule.length, schedule[0], schedule[11].starts_at]).toEqual([
      12,
      { week: 1, starts_at: '2027-01-06T21:30:00.000Z', link: 'https://zoom.us/j/wed', cancelled: false },
      '2027-03-24T21:30:00.000Z',
    ]);
  });

  test('WAM dates follow a start date change before the season starts', async () => {
    const { club, manager, s25, groupId, outsider } = await commandedGroup();

    await club.as(manager).query("update cycles set start_date = '2027-01-11' where id = $1", [s25.id]);

    expect((await wams(club, outsider, groupId, s25.id))[0].starts_at).toBe('2027-01-13T21:30:00.000Z');
  });

  test("a group commander reschedules one WAM without moving the others", async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();

    await club.as(sia).query(
      "select reschedule_wam($1, $2, 3, '2027-01-21T22:00:00Z', 'https://meet.example/once')", [groupId, s25.id]
    );

    const schedule = await wams(club, outsider, groupId, s25.id);
    expect([schedule[2], schedule[3]]).toEqual([
      { week: 3, starts_at: '2027-01-21T22:00:00.000Z', link: 'https://meet.example/once', cancelled: false },
      { week: 4, starts_at: '2027-01-27T21:30:00.000Z', link: 'https://zoom.us/j/wed', cancelled: false },
    ]);
  });

  test('a group commander cancels one WAM', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();

    await club.as(sia).query('select cancel_wam($1, $2, 5)', [groupId, s25.id]);

    expect((await wams(club, outsider, groupId, s25.id))[4].cancelled).toBe(true);
  });

  test("a member who isn't the commander cannot change a WAM", async () => {
    const { club, s25, groupId, members: [, jessica] } = await commandedGroup();

    await expect(club.as(jessica).query('select cancel_wam($1, $2, 5)', [groupId, s25.id]))
      .rejects.toThrow(/only the group's commander/i);
  });

  test('the rest of the roster is told when a WAM is cancelled', async () => {
    const { club, s25, groupId, sia, members: [, jessica] } = await commandedGroup();

    await club.as(sia).query('select cancel_wam($1, $2, 5)', [groupId, s25.id]);

    const [toJessica, toSia] = await Promise.all([
      club.as(jessica).query("select message from my_notices() where kind = 'wam_changed'"),
      club.as(sia).query("select message from my_notices() where kind = 'wam_changed'"),
    ]);
    expect([toJessica, toSia]).toEqual([[{ message: "Wed Mavericks's week 5 WAM is cancelled." }], []]);
  });

  test("the rest of the roster is told a rescheduled WAM's new time, in their time zone", async () => {
    const { club, s25, groupId, sia, members: [, jessica] } = await commandedGroup();
    await club.as(jessica).query("update profiles set timezone = 'America/New_York' where id = $1", [jessica.id]);

    await club.as(sia).query("select reschedule_wam($1, $2, 3, '2027-01-21T22:00:00Z', null)", [groupId, s25.id]);

    expect(await club.as(jessica).query("select message from my_notices() where kind = 'wam_changed'")).toEqual([
      { message: "Wed Mavericks's week 3 WAM moved to Thu 21 Jan, 5:00 PM." },
    ]);
  });
});

describe('my WAMs', () => {
  test("a member sees their own group's upcoming WAMs with the join link", async () => {
    const { club, s25, members: [, jessica] } = await commandedGroup();

    const mine = iso(await club.as(jessica).query(
      'select group_name, week, starts_at, link from my_wams() where cycle_id = $1 order by week limit 1', [s25.id]
    ));

    expect(mine).toEqual([
      { group_name: 'Wed Mavericks', week: 1, starts_at: '2027-01-06T21:30:00.000Z', link: 'https://zoom.us/j/wed' },
    ]);
  });

  test('a member gets a reminder the day before a WAM', async () => {
    const { club, manager, s25, groupId, members: [, jessica] } = await commandedGroup();
    // Start the season this week, with the WAM twelve hours from now.
    const soon = new Date(Date.now() + 12 * 3600e3);
    const monday = new Date(Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate() - ((soon.getUTCDay() + 6) % 7)));
    const slot = Math.round((soon - monday) / 60000);
    await club.as(manager).query('update cycles set start_date = $1 where id = $2', [monday.toISOString().slice(0, 10), s25.id]);
    await club.as(manager).query('update groups set slot_mow = $1 where id = $2', [slot, groupId]);

    const reminders = await club.as(jessica).query("select message, action from my_notices() where kind = 'wam_upcoming'");

    expect(reminders.map(r => r.action)).toEqual(['join_wam']);
  });
});
