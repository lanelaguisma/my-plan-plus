import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

// Wed Mavericks (Sia commanding) meeting Mondays 00:05 UTC in an active
// season that started `weeksAgo` Mondays ago.
async function commandedSeason(weeksAgo) {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  await club.owner('update groups set slot_mow = 5 where id = $1', [groupId]);
  await club.owner(
    `update cycles set status = 'active', start_date = (date_trunc('week', now() at time zone 'UTC') - make_interval(weeks => $2))::date
      where id = $1`, [s25.id, weeksAgo]);
  return { ...fixture, sia };
}
const asks = (club, person) => club.as(person).query(
  "select message, role, overdue from my_reminders() where kind = 'attendance_unconfirmed' order by key");
const confirm = (club, person, groupId, seasonId, week) =>
  club.as(person).query('select confirm_attendance($1, $2, $3, $4::uuid[])', [groupId, seasonId, week, []]);

describe('attendance unconfirmed reminder', () => {
  test('after a WAM its commander owes the attendance', async () => {
    const { club, sia } = await commandedSeason(0);

    expect((await asks(club, sia)).map(r => [r.message, r.role])).toEqual([
      ["Confirm who attended Wed Mavericks's week 1 WAM.", 'commander'],
    ]);
  });

  test('it goes overdue after 24 hours, and only the last two WAMs are asked about', async () => {
    const { club, sia } = await commandedSeason(3);

    expect((await asks(club, sia)).map(r => [r.message, r.overdue])).toEqual([
      ["Confirm who attended Wed Mavericks's week 3 WAM.", true],
      ["Confirm who attended Wed Mavericks's week 4 WAM.", now24hPassed()],
    ]);
  });

  test("confirming settles it, whether the commander or a club manager does it", async () => {
    const { club, manager, s25, groupId, sia } = await commandedSeason(1);

    await confirm(club, sia, groupId, s25.id, 2);
    await confirm(club, manager, groupId, s25.id, 1);

    expect(await asks(club, sia)).toEqual([]);
  });

  test('cancelled WAMs are not asked about, and members never see it', async () => {
    const { club, s25, groupId, sia, members: [, jessica] } = await commandedSeason(0);
    const forJessica = await asks(club, jessica);

    await club.as(sia).query('select cancel_wam($1, $2, 1)', [groupId, s25.id]);

    expect([forJessica, await asks(club, sia)]).toEqual([[], []]);
  });
});

// This week's WAM (Monday 00:05 UTC) is overdue once Monday 01:50 UTC has passed.
function now24hPassed() {
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7), 0, 5));
  return now.getTime() >= monday.getTime() + (45 + 24 * 60) * 60000;
}
