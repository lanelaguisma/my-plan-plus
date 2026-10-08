import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

// Wed Mavericks in an active season that started `weeksAgo` Mondays ago,
// meeting at 00:05 UTC on Mondays, so week N's WAM has ended by now
// whenever N <= weeksAgo + 1 (unless it is the first few minutes of a Monday).
async function activeSeason(weeksAgo) {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, s25, groupId } = fixture;
  await club.owner('update groups set slot_mow = 5 where id = $1', [groupId]);
  await club.owner(
    `update cycles set status = 'active', start_date = (date_trunc('week', now() at time zone 'UTC') - make_interval(weeks => $2))::date
      where id = $1`, [s25.id, weeksAgo]
  );
  await club.owner("update group_members set joined_at = now() - interval '200 days'");
  return fixture;
}
const reminders = (club, person) =>
  club.as(person).query("select key, message, role, overdue from my_reminders() where kind = 'checkin_missing' order by key");

describe('check-in missing reminder', () => {
  test("after this week's WAM, a member owes this week's check-in", async () => {
    const { club, s25, members: [sia] } = await activeSeason(0);

    expect(await reminders(club, sia)).toEqual([
      { key: `checkin:${s25.id}:1`, message: 'Your week 1 check-in is missing.', role: 'member', overdue: false },
    ]);
  });

  test('last week is overdue, and older weeks drop off', async () => {
    const { club, members: [sia] } = await activeSeason(3);

    expect((await reminders(club, sia)).map(r => [r.message, r.overdue])).toEqual([
      ['Your week 3 check-in is missing.', true],
      ['Your week 4 check-in is missing.', false],
    ]);
  });

  test('checking in clears it', async () => {
    const { club, s25, members: [sia] } = await activeSeason(0);

    await club.as(sia).query('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 1, 70)', [sia.id, s25.id]);

    expect(await reminders(club, sia)).toEqual([]);
  });

  test("a commander's on-behalf entry clears it too", async () => {
    const { club, manager, s25, groupId, members: [sia, jessica] } = await activeSeason(0);
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await club.as(sia).query('select enter_checkin_for($1, $2, 1, 75, null)', [jessica.id, s25.id]);

    expect(await reminders(club, jessica)).toEqual([]);
  });

  test("a cancelled WAM's week still needs a check-in", async () => {
    const { club, manager, s25, groupId, members: [sia] } = await activeSeason(0);
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await club.owner('insert into wam_overrides (group_id, cycle_id, week, cancelled) values ($1, $2, 1, true)', [groupId, s25.id]);

    expect((await reminders(club, sia)).map(r => r.message)).toEqual(['Your week 1 check-in is missing.']);
  });

  test('weeks before the member joined the roster do not count', async () => {
    const { club, members: [sia] } = await activeSeason(3);
    await club.owner("update group_members set joined_at = now() where user_id = $1", [sia.id]);

    expect(await reminders(club, sia)).toEqual([]);
  });

  test('no reminders before the season is running', async () => {
    const { club, s25, members: [sia] } = await activeSeason(0);
    await club.owner("update cycles set status = 'enrolling' where id = $1", [s25.id]);

    expect(await reminders(club, sia)).toEqual([]);
  });
});
