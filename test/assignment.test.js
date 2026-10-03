import { describe, expect, test } from 'vitest';
import { clubWithWedMavericks, seasonGroup, FRI_4PM_PT } from './fixtures.js';

async function withSecondGroup(fixture) {
  const { club, manager, s25 } = fixture;
  const [{ id }] = await club.as(manager).query(
    "select create_season_group($1, 'Fri-B', $2, '{}'::uuid[]) as id", [s25.id, FRI_4PM_PT]
  );
  return id;
}

describe('assignment', () => {
  test('a club manager assigns an unplaced member to a group', async () => {
    const { club, manager, s25, groupId, outsider } = await clubWithWedMavericks({ rosterSize: 3 });

    await club.as(manager).query('select assign_member($1, $2, $3)', [outsider.id, groupId, s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(4);
  });

  test('a club manager may assign beyond capacity', async () => {
    const { club, manager, s25, groupId, outsider } = await clubWithWedMavericks({ rosterSize: 4 });

    await club.as(manager).query('select assign_member($1, $2, $3)', [outsider.id, groupId, s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(5);
  });

  test('assigning a placed member moves them between groups', async () => {
    const fixture = await clubWithWedMavericks({ rosterSize: 3 });
    const { club, manager, s25, groupId, members: [sia], outsider } = fixture;
    const friB = await withSecondGroup(fixture);

    await club.as(manager).query('select assign_member($1, $2, $3)', [sia.id, friB, s25.id]);

    const counts = [
      (await seasonGroup(club, outsider, groupId, s25.id)).member_count,
      (await seasonGroup(club, outsider, friB, s25.id)).member_count,
    ];
    expect(counts).toEqual([2, 1]);
  });

  test('a member moved away and back is on the roster again', async () => {
    const fixture = await clubWithWedMavericks({ rosterSize: 3 });
    const { club, manager, s25, groupId, members: [sia], outsider } = fixture;
    const friB = await withSecondGroup(fixture);
    await club.as(manager).query('select assign_member($1, $2, $3)', [sia.id, friB, s25.id]);

    await club.as(manager).query('select assign_member($1, $2, $3)', [sia.id, groupId, s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(3);
  });

  test('moving a group commander leaves their old group without one', async () => {
    const fixture = await clubWithWedMavericks({ rosterSize: 3 });
    const { club, manager, s25, groupId, members: [sia], outsider } = fixture;
    const friB = await withSecondGroup(fixture);
    await club.as(manager).query('select appoint_group_commander($1, $2, $3)', [groupId, s25.id, sia.id]);

    await club.as(manager).query('select assign_member($1, $2, $3)', [sia.id, friB, s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).commander_name).toBeNull();
  });

  test('a club manager removes a member from their roster', async () => {
    const { club, manager, s25, groupId, members: [sia], outsider } = await clubWithWedMavericks({ rosterSize: 3 });

    await club.as(manager).query('select remove_from_roster($1, $2)', [sia.id, s25.id]);

    expect((await seasonGroup(club, outsider, groupId, s25.id)).member_count).toBe(2);
  });

  test('a member cannot assign anyone', async () => {
    const { club, s25, groupId, members: [sia], outsider } = await clubWithWedMavericks({ rosterSize: 3 });

    const assigning = club.as(sia).query('select assign_member($1, $2, $3)', [outsider.id, groupId, s25.id]);

    await expect(assigning).rejects.toThrow(/only a club manager/i);
  });

  test('a member cannot put themselves on a roster directly', async () => {
    const { club, s25, groupId, outsider } = await clubWithWedMavericks({ rosterSize: 3 });

    const joining = club.as(outsider).query(
      'insert into group_members (group_id, cycle_id, user_id) values ($1, $2, $3)', [groupId, s25.id, outsider.id]
    );

    await expect(joining).rejects.toThrow(/row-level security/i);
  });
});
