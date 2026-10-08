import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup } from './fixtures.js';

async function commandedGroup({ rosterSize = 3 } = {}) {
  const fixture = await clubWithWedMavericks({ rosterSize });
  const { club, manager, s25, groupId, members: [sia] } = fixture;
  await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);
  return { ...fixture, sia };
}

async function requestToJoin(club, member, groupId, seasonId) {
  const [{ id }] = await club.as(member).query('select send_join_request($1, $2) as id', [groupId, seasonId]);
  return id;
}

describe('join requests', () => {
  test("a member whose join request is approved is on the group's roster", async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const request = await requestToJoin(club, outsider, groupId, s25.id);

    await club.as(sia).query('select respond_to_offer($1, true)', [request]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(4);
  });

  test("the group's commander is told about a join request", async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();

    await requestToJoin(club, outsider, groupId, s25.id);

    expect(await club.as(sia).query("select message, action from my_notices() where kind = 'join_request'")).toEqual([
      { message: 'Outsider asked to join Wed Mavericks for Season 25.', action: 'review_join_requests' },
    ]);
  });

  test('a member is told when their join request is declined', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const request = await requestToJoin(club, outsider, groupId, s25.id);

    await club.as(sia).query('select respond_to_offer($1, false)', [request]);

    expect(await club.as(outsider).query("select message from my_notices() where kind = 'join_request_answered'")).toEqual([
      { message: 'Your request to join Wed Mavericks was declined.' },
    ]);
  });

  test('a member cannot ask to join a full group', async () => {
    const { club, s25, groupId, outsider } = await commandedGroup({ rosterSize: 4 });

    await expect(requestToJoin(club, outsider, groupId, s25.id)).rejects.toThrow(/no open places/i);
  });

  test('a member cannot ask to join the group they are already in', async () => {
    const { club, s25, groupId, members: [, jessica] } = await commandedGroup();

    await expect(requestToJoin(club, jessica, groupId, s25.id)).rejects.toThrow(/already in this group/i);
  });

  test("only the group's commander or a club manager can approve a join request", async () => {
    const { club, s25, groupId, members: [, jessica], outsider } = await commandedGroup();
    const request = await requestToJoin(club, outsider, groupId, s25.id);

    await expect(club.as(jessica).query('select respond_to_offer($1, true)', [request]))
      .rejects.toThrow(/only the group's commander/i);
  });

  test('a member can withdraw their own join request', async () => {
    const { club, s25, groupId, sia, outsider } = await commandedGroup();
    const request = await requestToJoin(club, outsider, groupId, s25.id);

    await club.as(outsider).query('select withdraw_offer($1)', [request]);

    expect(await club.as(sia).query('select status from group_offers($1, $2)', [groupId, s25.id])).toEqual([{ status: 'withdrawn' }]);
  });
});
