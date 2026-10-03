import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup, FRI_4PM_PT } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica, Shan) in its fourth week; Fri-B
// (Kiran commanding) has room.
async function runningClub() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia, jessica, shan] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
  const [{ id: friB }] = await club.as(manager).query(
    "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s25.id, FRI_4PM_PT, [kiran.id]]
  );
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [friB, s25.id, kiran.id]);
  await club.owner(
    "update cycles set status = 'active', start_date = (date_trunc('week', now()) - interval '21 days')::date where id = $1",
    [s25.id]
  );
  // Rosters were set during enrolment, before the season began.
  await club.owner(
    'update group_members r set joined_at = c.start_date::timestamptz - interval \'7 days\' from cycles c where c.id = r.cycle_id'
  );
  return { ...fixture, sia, jessica, shan, kiran, friB };
}

const noticesOf = (club, person, kind) =>
  club.as(person).query('select message from my_notices() where kind = $1', [kind]);

describe('leaving a group', () => {
  test('a member who leaves is unplaced straight away', async () => {
    const { club, manager, s25, groupId, jessica, outsider } = await runningClub();
    await club.as(jessica).query("update profiles set slots = '[1]' where id = $1", [jessica.id]);

    await club.as(jessica).query('select leave_group($1)', [s25.id]);

    expect([
      (await seasonGroup(club, outsider, groupId, s25.id)).member_count,
      (await club.as(manager).query('select full_name from unplaced_members($1)', [s25.id])).map(r => r.full_name),
    ]).toEqual([2, ['Jessica']]);
  });

  test('the group commander is told when a member leaves', async () => {
    const { club, s25, sia, jessica } = await runningClub();

    await club.as(jessica).query('select leave_group($1)', [s25.id]);

    expect(await noticesOf(club, sia, 'member_left')).toEqual([{ message: 'Jessica left Wed Mavericks.' }]);
  });

  test('a group commander who leaves gives up the role', async () => {
    const { club, s25, groupId, sia, outsider } = await runningClub();

    await club.as(sia).query('select leave_group($1)', [s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).commander_name).toBeNull();
  });
});

describe('departures recorded by a group commander', () => {
  test('recording a departure frees the place and tells the club managers', async () => {
    const { club, manager, s25, groupId, sia, jessica, outsider } = await runningClub();

    await club.as(sia).query("select record_departure($1, $2, $3, 'stopped attending')", [jessica.id, groupId, s25.id]);

    expect([
      (await seasonGroup(club, outsider, groupId, s25.id)).vacancies,
      await noticesOf(club, manager, 'departure_recorded'),
    ]).toEqual([2, [{ message: 'Sia recorded that Jessica left Wed Mavericks (stopped attending).' }]]);
  });

  test("a group commander cannot record a departure from another group", async () => {
    const { club, s25, friB, sia, kiran } = await runningClub();

    await expect(club.as(sia).query("select record_departure($1, $2, $3, 'asked to leave')", [kiran.id, friB, s25.id]))
      .rejects.toThrow(/only the group's commander/i);
  });

  test('a club manager can reverse a departure', async () => {
    const { club, manager, s25, groupId, sia, jessica, outsider } = await runningClub();
    await club.as(sia).query("select record_departure($1, $2, $3, 'stopped attending')", [jessica.id, groupId, s25.id]);

    await club.as(manager).query('select reverse_departure($1, $2, $3)', [jessica.id, groupId, s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(3);
  });
});

describe('transfer requests', () => {
  test('a member asking to transfer stays on their roster until a club manager moves them', async () => {
    const { club, manager, s25, groupId, friB, jessica, outsider } = await runningClub();

    await club.as(jessica).query("select request_transfer($1, 'I need a Friday group')", [s25.id]);
    const whileWaiting = (await seasonGroup(club, outsider, groupId, s25.id)).member_count;
    const open = await club.as(manager).query('select member_name, from_group, reason from open_transfer_requests($1)', [s25.id]);
    await club.as(manager).query('select assign_member($1, $2, $3)', [jessica.id, friB, s25.id]);

    expect([whileWaiting, open, await club.as(manager).query('select * from open_transfer_requests($1)', [s25.id])]).toEqual([
      3, [{ member_name: 'Jessica', from_group: 'Wed Mavericks', reason: 'I need a Friday group' }], [],
    ]);
  });

  test('club managers are told about a transfer request', async () => {
    const { club, manager, s25, jessica } = await runningClub();

    await club.as(jessica).query("select request_transfer($1, 'I need a Friday group')", [s25.id]);

    expect(await noticesOf(club, manager, 'transfer_request')).toEqual([
      { message: 'Jessica asked to move from Wed Mavericks: I need a Friday group' },
    ]);
  });

  test('a member can cancel their transfer request', async () => {
    const { club, manager, s25, jessica } = await runningClub();
    await club.as(jessica).query("select request_transfer($1, 'Maybe')", [s25.id]);

    await club.as(jessica).query('select cancel_transfer_request($1)', [s25.id]);

    expect(await club.as(manager).query('select * from open_transfer_requests($1)', [s25.id])).toEqual([]);
  });
});

describe("a group's check-in history", () => {
  test("keeps a departed member's earlier weeks but not their later ones", async () => {
    const { club, s25, groupId, sia, jessica } = await runningClub();
    for (const week of [1, 2]) {
      await club.as(jessica).query('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, $3, 70)', [jessica.id, s25.id, week]);
    }
    await club.as(jessica).query('select leave_group($1)', [s25.id]);
    await club.as(jessica).query('insert into checkins (user_id, cycle_id, week, score) values ($1, $2, 6, 90)', [jessica.id, s25.id]);

    const history = await club.as(sia).query(
      'select week from group_checkins($1, $2) where user_id = $3 order by week', [groupId, s25.id, jessica.id]
    );

    expect(history.map(h => h.week)).toEqual([1, 2]);
  });
});
