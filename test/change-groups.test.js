import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup, FRI_4PM_PT } from './fixtures.js';

// Wed Mavericks (Sia commanding, Jessica, Shan); Fri-B (Kiran commanding) with room.
async function twoGroups() {
  const fixture = await clubWithWedMavericks({ rosterSize: 3 });
  const { club, manager, s25, groupId, members: [sia, jessica, shan] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  const kiran = await club.register({ email: 'kiran@example.com', fullName: 'Kiran' });
  const [{ id: friB }] = await club.as(manager).query(
    "select create_season_group($1, 'Fri-B', $2, $3::uuid[]) as id", [s25.id, FRI_4PM_PT, [kiran.id]]
  );
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [friB, s25.id, kiran.id]);
  return { ...fixture, sia, jessica, shan, kiran, friB };
}

const askToJoin = (club, who, groupId, seasonId) =>
  club.as(who).query('select send_join_request($1, $2) as id', [groupId, seasonId]).then(r => r[0].id);
const noticesOf = (club, who, kind) =>
  club.as(who).query('select message from my_notices() where kind = $1', [kind]).then(r => r.map(n => n.message));

describe('changing groups by applying', () => {
  test('a placed member keeps their place while their request is pending', async () => {
    const { club, s25, groupId, friB, jessica, outsider } = await twoGroups();

    await askToJoin(club, jessica, friB, s25.id);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(3);
  });

  test("the receiving commander sees which group the request comes from", async () => {
    const { club, s25, friB, jessica, kiran } = await twoGroups();

    await askToJoin(club, jessica, friB, s25.id);

    expect([
      await noticesOf(club, kiran, 'join_request'),
      (await club.as(kiran).query('select member_name, current_group from group_offers($1, $2)', [friB, s25.id])),
    ]).toEqual([
      ['Jessica (currently in Wed Mavericks) asked to join Fri-B for Season 25.'],
      [{ member_name: 'Jessica', current_group: 'Wed Mavericks' }],
    ]);
  });

  test('approval moves the member, frees their old place and tells both commanders', async () => {
    const { club, s25, groupId, friB, sia, jessica, kiran, outsider } = await twoGroups();
    const id = await askToJoin(club, jessica, friB, s25.id);

    await club.as(kiran).query('select respond_to_offer($1, true)', [id]);

    expect([
      (await seasonGroup(club, outsider, groupId, s25.id)).vacancies,
      (await seasonGroup(club, outsider, friB, s25.id)).member_count,
      await noticesOf(club, sia, 'member_moved'),
      await noticesOf(club, jessica, 'join_request_answered'),
    ]).toEqual([2, 2, ['Jessica moved from Wed Mavericks to Fri-B.'], ['Your request to join Fri-B was approved.']]);
  });

  test("a move is not a departure", async () => {
    const { club, manager, s25, friB, sia, jessica, kiran } = await twoGroups();
    const id = await askToJoin(club, jessica, friB, s25.id);

    await club.as(kiran).query('select respond_to_offer($1, true)', [id]);

    expect([
      await club.as(manager).query('select member_name from season_departures($1)', [s25.id]),
      await noticesOf(club, manager, 'departure_recorded'),
      await noticesOf(club, sia, 'member_left'),
    ]).toEqual([[], [], []]);
  });

  test("approval withdraws the member's other requests and resolves a transfer request", async () => {
    const { club, manager, s25, friB, jessica, kiran } = await twoGroups();
    const [{ id: tue }] = await club.as(manager).query("select create_season_group($1, 'Tue', 100) as id", [s25.id]);
    await club.as(jessica).query("select request_transfer($1, 'Fridays suit me')", [s25.id]);
    const other = await askToJoin(club, jessica, tue, s25.id);
    const id = await askToJoin(club, jessica, friB, s25.id);

    await club.as(kiran).query('select respond_to_offer($1, true)', [id]);

    expect([
      (await club.as(jessica).query('select status from my_offers() where id = $1', [other]))[0].status,
      await club.as(manager).query('select id from open_transfer_requests($1)', [s25.id]),
    ]).toEqual(['withdrawn', []]);
  });

  test('a group commander cannot apply out of the group they command', async () => {
    const { club, s25, friB, sia } = await twoGroups();

    await expect(askToJoin(club, sia, friB, s25.id)).rejects.toThrow(/you command your group/i);
  });

  test('an unplaced member still asks to join as before', async () => {
    const { club, s25, friB, kiran, outsider } = await twoGroups();
    const id = await askToJoin(club, outsider, friB, s25.id);

    await club.as(kiran).query('select respond_to_offer($1, true)', [id]);

    expect((await seasonGroup(club, outsider, friB, s25.id)).member_count).toBe(2);
  });
});
