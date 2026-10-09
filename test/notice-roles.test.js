import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks } from './fixtures.js';

const roles = (club, person, kind) =>
  club.as(person).query('select role from my_notices() where kind = $1', [kind]).then(r => r.map(x => x.role));

describe('notice roles', () => {
  test("a join request goes to the commander's Commander mode", async () => {
    const { club, manager, s25, groupId, members: [sia], outsider } = await clubWithWedMavericks();
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await club.as(outsider).query('select send_join_request($1, $2)', [groupId, s25.id]);

    expect(await roles(club, sia, 'join_request')).toEqual(['commander']);
  });

  test('a join request to a group without a commander goes to Club manager mode', async () => {
    const { club, manager, s25, groupId, outsider } = await clubWithWedMavericks();

    await club.as(outsider).query('select send_join_request($1, $2)', [groupId, s25.id]);

    expect(await roles(club, manager, 'join_request')).toEqual(['manager']);
  });

  test("the commander's answer reaches the member in Member mode", async () => {
    const { club, manager, s25, groupId, members: [sia], outsider } = await clubWithWedMavericks();
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
    const [{ id }] = await club.as(outsider).query('select send_join_request($1, $2) as id', [groupId, s25.id]);

    await club.as(sia).query('select respond_to_offer($1, false)', [id]);

    expect(await roles(club, outsider, 'join_request_answered')).toEqual(['member']);
  });

  test('club-wide matters go to Club manager mode', async () => {
    const { club, manager, s25, members: [sia] } = await clubWithWedMavericks();

    await club.as(sia).query("select request_transfer($1, 'Fridays suit me better')", [s25.id]);

    expect(await roles(club, manager, 'transfer_request')).toEqual(['manager']);
  });

  test("a member's own reminders are in Member mode", async () => {
    const { club, members: [sia] } = await clubWithWedMavericks();
    await club.owner("update group_members set status = 'awaiting_continuation' where user_id = $1", [sia.id]);

    expect(await club.as(sia).query("select role from my_reminders() where kind = 'continuation'")).toEqual([{ role: 'member' }]);
  });
});
